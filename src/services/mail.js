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

/**
 * Čisti vrednost koja ide u JEDNO zaglavlje poruke.
 *
 * Prelom reda u naslovu ili adresi je ubacivanje zaglavlja: "Racun\r\nBcc:
 * neko@drugde" bi u sirovoj poruci postalo pravi Bcc i tiho poslalo kopiju.
 * Pošto tekst ovde stiže od modela (a model čita tuđe mejlove), ovo mora da
 * se seče u kodu, ne u promptu.
 */
function headerSafe(value, label) {
  if (value === undefined || value === null) return value;
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    logger.warn(`Mail: uklonjen prelom reda iz zaglavlja "${label}" (pokušaj ubacivanja?).`);
  }
  // Prelome zamenjujemo razmakom da naslov ostane čitljiv.
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** Sva zaglavlja jedne poruke odjednom; telo se NE dira. */
function sanitizeHeaders({ to, cc, subject, inReplyTo }) {
  return {
    to: headerSafe(to, 'To'),
    cc: headerSafe(cc, 'Cc'),
    subject: headerSafe(subject, 'Subject'),
    inReplyTo: headerSafe(inReplyTo, 'In-Reply-To'),
  };
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
 * Sklapa IMAP upit iz ljudski zadatih filtera.
 *
 * Prazan objekat znači "sve u folderu" — ImapFlow to prihvata kao `{all: true}`.
 */
function napraviUpit({ unread, from, to, subject, text, since, before }) {
  const upit = {};

  if (unread === true) upit.seen = false;
  if (unread === false) upit.seen = true;
  if (from) upit.from = from;
  if (to) upit.to = to;
  if (subject) upit.subject = subject;
  // `body` pretražuje telo poruke; server to radi, ne mi.
  if (text) upit.body = text;
  if (since) upit.since = new Date(since);
  if (before) upit.before = new Date(before);

  return Object.keys(upit).length ? upit : { all: true };
}

/** Zajednički oblik jedne poruke u listi. */
function ukratko(uid, parsed, flags) {
  return {
    uid,
    from: parsed.from?.text || '',
    to: parsed.to?.text || '',
    subject: parsed.subject || '(bez naslova)',
    date: parsed.date?.toISOString() || null,
    procitan: flags ? flags.has('\\Seen') : undefined,
    prilozi: (parsed.attachments || []).map((p) => p.filename).filter(Boolean),
    preview: (parsed.text || '').trim().slice(0, 500),
  };
}

/**
 * Pretraga sandučeta — vraća i pročitane i nepročitane poruke, najnovije prvo.
 *
 * Ranije je bot video SAMO nepročitano: čim pročitaš mejl na telefonu, za njega
 * je nestao. Ovim može da pretraži ceo inbox (i druge foldere) po pošiljaocu,
 * naslovu, tekstu i datumu.
 *
 * VAŽNO: ImapFlow čita preko BODY.PEEK, pa se poruke NE označavaju kao
 * pročitane. To mora tako da ostane — bot ne sme da ti menja stanje sandučeta
 * time što je nešto pogledao.
 */
export async function listMessages({ folder = 'INBOX', limit = 20, ...filteri } = {}) {
  ensureConfigured();
  const imap = makeImapClient();
  await imap.connect();
  const messages = [];

  try {
    const lock = await imap.getMailboxLock(folder);
    try {
      const uids = await imap.search(napraviUpit(filteri));
      // search vraća rastuće po UID-u; poslednji su najnoviji.
      const izabrani = uids.slice(-limit).reverse();

      for (const uid of izabrani) {
        const msg = await imap.fetchOne(uid, { envelope: true, source: true, flags: true });
        if (!msg) continue;
        const parsed = await simpleParser(msg.source);
        messages.push(ukratko(uid, parsed, msg.flags));
      }
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout();
  }

  logger.debug(`Mail listMessages (${folder}): ${messages.length} poruka`);
  return messages;
}

/**
 * Cela jedna poruka — telo bez skraćivanja, primaoci, spisak priloga.
 *
 * Lista vraća samo 500 znakova pregleda; ovo je za "pročitaj mi taj mejl".
 * Takođe ne menja \Seen (vidi napomenu kod listMessages).
 */
export async function readMessage({ uid, folder = 'INBOX', maxZnakova = 20000 }) {
  ensureConfigured();
  if (uid === undefined || uid === null || Number.isNaN(Number(uid))) {
    throw new Error('Nedostaje uid poruke (dobija se iz mail_search ili mail_list_unread).');
  }

  const imap = makeImapClient();
  await imap.connect();

  try {
    const lock = await imap.getMailboxLock(folder);
    try {
      const msg = await imap.fetchOne(Number(uid), {
        envelope: true,
        source: true,
        flags: true,
      });
      if (!msg) throw new Error(`Ne nalazim poruku sa uid ${uid} u folderu "${folder}".`);

      const parsed = await simpleParser(msg.source);
      const telo = (parsed.text || '').trim();

      return {
        uid: Number(uid),
        folder,
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        cc: parsed.cc?.text || '',
        subject: parsed.subject || '(bez naslova)',
        date: parsed.date?.toISOString() || null,
        procitan: msg.flags ? msg.flags.has('\\Seen') : undefined,
        messageId: parsed.messageId || null,
        prilozi: (parsed.attachments || []).map((p) => ({
          naziv: p.filename || '(bez imena)',
          tip: p.contentType,
          velicinaKb: p.size ? Math.round(p.size / 1024) : null,
        })),
        // Jako duge poruke (newsletteri) inače pojedu ceo kontekst modela.
        telo: telo.slice(0, maxZnakova),
        skraceno: telo.length > maxZnakova,
      };
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout();
  }
}

/**
 * Spisak foldera na nalogu.
 *
 * Nazivi se razlikuju od servera do servera (Gmail ima "[Gmail]/Sent Mail",
 * cPanel "INBOX.Sent"), pa bez ovoga model mora da pogađa ime foldera.
 */
export async function listFolders() {
  ensureConfigured();
  const imap = makeImapClient();
  await imap.connect();

  try {
    const lista = await imap.list();
    return lista
      .filter((f) => !f.flags?.has('\\Noselect'))
      .map((f) => ({ putanja: f.path, naziv: f.name, namena: f.specialUse || null }));
  } finally {
    await imap.logout();
  }
}

/**
 * Vraća nepročitane mejlove iz INBOX-a (najnovije prvo).
 * Tanak omotač oko listMessages — koristi ga jutarnji pregled i satna provera.
 */
export async function listUnread({ limit = 10 } = {}) {
  return listMessages({ folder: 'INBOX', limit, unread: true });
}

/**
 * Šalje mejl. Ako je podešen RESEND_API_KEY — šalje preko Resend API-ja
 * (HTTPS, zaobilazi blokirane SMTP portove); inače preko klasičnog SMTP-a.
 * From adresa je u oba slučaja tvoja (config.mail.from).
 */
export async function sendMail({ to, subject, body, cc, inReplyTo }) {
  const fromAddress = headerSafe(config.mail.from.address || config.mail.smtp.user, 'From');
  const from = config.mail.from.name
    ? `${headerSafe(config.mail.from.name, 'From')} <${fromAddress}>`
    : fromAddress;

  const čisto = sanitizeHeaders({ to, cc, subject, inReplyTo });
  if (!čisto.to) throw new Error('Nedostaje primalac (to).');

  if (config.mail.resendApiKey) {
    return sendViaResend({ from, body, ...čisto });
  }
  return sendViaSmtp({ from, body, ...čisto });
}

/** Slanje preko Resend HTTP API-ja (port 443). */
async function sendViaResend({ from, to, subject, body, cc, inReplyTo }) {
  const payload = {
    from,
    to: [to],
    subject,
    text: body,
    ...(cc ? { cc: [cc] } : {}),
    ...(inReplyTo ? { headers: { 'In-Reply-To': inReplyTo, References: inReplyTo } } : {}),
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.mail.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend greška ${res.status}: ${data?.message || JSON.stringify(data)}`);
  }
  logger.info(`Mail poslat preko Resend na ${to} (id: ${data.id})`);
  return { messageId: data.id, provider: 'resend' };
}

/** Slanje preko klasičnog SMTP-a (nodemailer). */
async function sendViaSmtp({ from, to, subject, body, cc, inReplyTo }) {
  ensureConfigured();
  const transporter = nodemailer.createTransport({
    host: config.mail.smtp.host,
    port: config.mail.smtp.port,
    secure: config.mail.smtp.secure,
    auth: { user: config.mail.smtp.user, pass: config.mail.smtp.password },
    // Bolje brza greška nego da handler visi (npr. ako provajder blokira SMTP port).
    connectionTimeout: 15000, // 15s za TCP konekciju
    greetingTimeout: 10000, // 10s za SMTP pozdrav
    socketTimeout: 20000, // 20s neaktivnosti
  });

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
  const fromAddress = headerSafe(config.mail.from.address || config.mail.smtp.user, 'From');
  const čisto = sanitizeHeaders({ to, cc, subject });
  if (!čisto.to) throw new Error('Nedostaje primalac (to).');

  const raw = buildRawMessage({ from: fromAddress, body, ...čisto });

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

/**
 * Sastavlja sirovu RFC 822 poruku za IMAP draft.
 * Vrednosti zaglavlja MORAJU proći kroz sanitizeHeaders pre ovoga — ovde se
 * radi još jedno sečenje kao pojas i tregeri, jer je ovo mesto gde bi prelom
 * reda postao pravo zaglavlje.
 */
function buildRawMessage({ from, to, cc, subject, body }) {
  const h = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ');
  const lines = [
    `From: ${h(from)}`,
    `To: ${h(to)}`,
    cc ? `Cc: ${h(cc)}` : null,
    `Subject: ${h(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].filter((l) => l !== null);
  return lines.join('\r\n');
}
