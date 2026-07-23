import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';

/**
 * Mail servis: IMAP za čitanje/draftove, SMTP za slanje.
 * Radi sa Gmail-om (App Password) i bilo kojim standardnim IMAP/SMTP nalogom.
 */

function ensureConfigured() {
  if (!featureEnabled.mail) {
    throw new Error('Mail nije konfigurisan (nedostaju IMAP_USER/IMAP_PASSWORD).');
  }
}

function makeImapClient() {
  return new ImapFlow({
    host: config.mail.imap.host,
    port: config.mail.imap.port,
    secure: true,
    auth: { user: config.mail.imap.user, pass: config.mail.imap.password },
    logger: false,
  });
}

/**
 * Vraća nepročitane mejlove iz INBOX-a (najnovije prvo).
 */
export async function listUnread({ limit = 10 } = {}) {
  ensureConfigured();
  const imap = makeImapClient();
  await imap.connect();
  const messages = [];

  try {
    const lock = await imap.getMailboxLock('INBOX');
    try {
      const uids = await imap.search({ seen: false });
      const recent = uids.slice(-limit).reverse();

      for (const uid of recent) {
        const msg = await imap.fetchOne(uid, { envelope: true, source: true });
        if (!msg) continue;
        const parsed = await simpleParser(msg.source);
        messages.push({
          uid,
          from: parsed.from?.text || '',
          subject: parsed.subject || '(bez naslova)',
          date: parsed.date?.toISOString() || null,
          preview: (parsed.text || '').trim().slice(0, 500),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout();
  }

  logger.debug(`Mail listUnread: ${messages.length} poruka`);
  return messages;
}

/**
 * Šalje mejl preko SMTP-a.
 */
export async function sendMail({ to, subject, body, cc, inReplyTo }) {
  ensureConfigured();
  const transporter = nodemailer.createTransport({
    host: config.mail.smtp.host,
    port: config.mail.smtp.port,
    secure: config.mail.smtp.secure,
    auth: { user: config.mail.smtp.user, pass: config.mail.smtp.password },
  });

  const fromAddress = config.mail.from.address || config.mail.smtp.user;
  const from = config.mail.from.name
    ? `"${config.mail.from.name}" <${fromAddress}>`
    : fromAddress;

  const info = await transporter.sendMail({
    from,
    to,
    cc,
    subject,
    text: body,
    inReplyTo,
    references: inReplyTo,
  });

  logger.info(`Mail poslat na ${to} (messageId: ${info.messageId})`);
  return { messageId: info.messageId, accepted: info.accepted };
}

/**
 * Snima draft u "Drafts" folder (bez slanja).
 */
export async function saveDraft({ to, subject, body, cc }) {
  ensureConfigured();
  const fromAddress = config.mail.from.address || config.mail.smtp.user;
  const raw = buildRawMessage({ from: fromAddress, to, cc, subject, body });

  const imap = makeImapClient();
  await imap.connect();
  try {
    // Gmail koristi "[Gmail]/Drafts"; za druge servere obično je "Drafts".
    const draftsBox = (await imap.mailboxExists('[Gmail]/Drafts'))
      ? '[Gmail]/Drafts'
      : 'Drafts';
    await imap.append(draftsBox, raw, ['\\Draft']);
    logger.info(`Mail: draft snimljen u "${draftsBox}" (za ${to})`);
    return { saved: true, mailbox: draftsBox };
  } finally {
    await imap.logout();
  }
}

function buildRawMessage({ from, to, cc, subject, body }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].filter((l) => l !== null);
  return lines.join('\r\n');
}
