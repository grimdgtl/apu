import cron from 'node-cron';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { sendMessage } from './telegram.js';
import { generateText } from './claude.js';
import * as calendar from './calendar.js';
import * as notion from './notion.js';
import { checkAllSites, formatReport } from './monitor.js';
import { getForecastLine } from './weather.js';
import * as mail from './mail.js';
import { loadState, saveState } from '../store.js';

/**
 * Scheduler — proaktivni podsetnici preko cron izraza.
 *
 *   1. Jutarnji pregled — svaki dan u 10:00.
 *   2. Podsetnik za porez — 14. u mesecu u 10:00.
 *   3. Tiha provera sajtova — svaki dan u 10:00 (javi samo ako ima problema).
 *   4. Pun izveštaj o sajtovima — svaki dan u 18:00 (uvek javi).
 *
 * Cron izrazi i vremenska zona dolaze iz config-a.
 */

export function startScheduler() {
  const options = { timezone: config.timezone };

  cron.schedule(config.cron.morningBriefing, morningBriefing, options);
  logger.info(`Zakazan jutarnji pregled: "${config.cron.morningBriefing}" (${config.timezone})`);

  cron.schedule(config.cron.taxReminder, taxReminder, options);
  logger.info(`Zakazan podsetnik za porez: "${config.cron.taxReminder}" (${config.timezone})`);

  if (featureEnabled.siteMonitor) {
    cron.schedule(config.cron.siteCheckSilent, () => siteCheck(false), options);
    cron.schedule(config.cron.siteCheckReport, () => siteCheck(true), options);
    logger.info(
      `Zakazan monitoring sajtova: tiho "${config.cron.siteCheckSilent}", ` +
        `izveštaj "${config.cron.siteCheckReport}" (${config.timezone})`,
    );
  } else {
    logger.info('Monitoring sajtova preskočen (NOTION_CLIENTS_DB_ID nije podešen).');
  }

  if (featureEnabled.mail) {
    cron.schedule(config.cron.mailCheck, mailCheck, options);
    logger.info(`Zakazana provera mejlova: "${config.cron.mailCheck}" (${config.timezone})`);
  } else {
    logger.info('Provera mejlova preskočena (IMAP nije podešen).');
  }
}

/**
 * Periodična provera nepročitanih mejlova.
 *
 * Javlja SAMO o mejlovima o kojima ranije nije javio — inače bi ti isti
 * nepročitan mejl stizao svakog sata. Lista UID-ova o kojima je javljeno
 * čuva se na disk (preživi restart) i sama se čisti: kad mejl pročitaš,
 * ispada iz nepročitanih pa i iz te liste.
 */
async function mailCheck() {
  try {
    const unread = await mail.listUnread({ limit: 15 });

    // Prethodno javljeni UID-ovi (sa diska).
    const notified = new Set(loadState('notified-mail', []));
    const fresh = unread.filter((m) => !notified.has(m.uid));

    // Novo stanje = trenutno nepročitani (pročitani automatski ispadaju).
    saveState('notified-mail', unread.map((m) => m.uid));

    if (fresh.length === 0) {
      logger.debug(`Provera mejlova: nema novih (ukupno nepročitanih: ${unread.length}).`);
      return;
    }

    const lines = fresh.map((m) => `• ${m.subject}\n  od: ${m.from}`);
    const naslov =
      fresh.length === 1 ? 'Imaš 1 nov nepročitan mejl:' : `Imaš ${fresh.length} nova nepročitana mejla:`;
    const ostatak =
      unread.length > fresh.length ? `\n\n(ukupno nepročitanih: ${unread.length})` : '';

    await sendMessage(`📬 ${naslov}\n\n${lines.join('\n')}${ostatak}`);
    logger.info(`Provera mejlova: javljeno o ${fresh.length} novih mejlova.`);
  } catch (err) {
    // Ne diži buku svakog sata ako IMAP zezne — samo loguj.
    logger.error('Greška pri proveri mejlova:', err.message);
  }
}

/**
 * Skuplja današnje događaje i otvorene zadatke, pa traži od Claude-a lep pregled.
 */
async function morningBriefing() {
  logger.info('Pokrećem jutarnji pregled...');
  try {
    const parts = [];

    if (featureEnabled.weather) {
      const weather = await getForecastLine();
      if (weather) parts.push(`Vremenska prognoza za danas:\n${weather}`);
    }

    if (featureEnabled.calendar) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const events = await calendar.listEvents({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
      });
      parts.push(`Današnji događaji iz kalendara:\n${JSON.stringify(events, null, 2)}`);
    }

    if (featureEnabled.notionTasks) {
      // Samo otvoreni zadaci — završeni ne trebaju u jutarnjem pregledu.
      const notStarted = await notion.listTasks({ status: 'Not started', limit: 15 });
      const inProgress = await notion.listTasks({ status: 'In progress', limit: 15 });
      parts.push(
        `Otvoreni zadaci iz Notion-a:\n${JSON.stringify([...inProgress, ...notStarted], null, 2)}`,
      );
    }

    const raw = parts.length
      ? parts.join('\n\n')
      : 'Nema dostupnih podataka iz kalendara ni Notion-a.';

    const text = await generateText(
      `Napravi kratak, prijateljski jutarnji pregled dana na srpskom na osnovu ovih podataka. ` +
        `Ako ima prognoze, počni jednom rečenicom o vremenu. Zatim istakni sastanke po vremenu ` +
        `i najvažnije zadatke. Budi konkretan i sažet.\n\n${raw}`,
    );

    await sendMessage(`☀️ Dobro jutro! Evo pregleda za danas:\n\n${text}`);
  } catch (err) {
    logger.error('Greška u jutarnjem pregledu:', err);
    await sendMessage('☀️ Dobro jutro! (Nisam uspeo da povučem sve podatke za pregled.)').catch(
      () => {},
    );
  }
}

/**
 * Provera dostupnosti sajtova klijenata.
 *
 * @param {boolean} full - true = pun izveštaj (18:00, uvek šalje),
 *                         false = tiho (10:00, šalje samo ako ima problema).
 */
async function siteCheck(full) {
  logger.info(`Pokrećem proveru sajtova (${full ? 'pun izveštaj' : 'tiho'})...`);
  try {
    const data = await checkAllSites();
    const message = formatReport(data, full);
    if (message) {
      await sendMessage(message);
    } else {
      logger.info('Monitoring: svi sajtovi OK — tihi režim, ne šaljem poruku.');
    }
  } catch (err) {
    logger.error('Greška u proveri sajtova:', err);
    // I u tihom režimu javljamo grešku samog monitoringa — inače bi tiho zakazao.
    await sendMessage(
      '🌐 Nisam uspeo da proverim sajtove (greška u monitoringu ili Notion bazi).',
    ).catch(() => {});
  }
}

/**
 * Mesečni podsetnik za plaćanje poreza.
 */
async function taxReminder() {
  logger.info('Šaljem podsetnik za porez...');
  try {
    await sendMessage(
      '🧾 Podsetnik: danas je 14. u mesecu — vreme je da platiš porez i doprinose. ' +
        'Ne zaboravi da izmiriš obaveze na vreme.',
    );
  } catch (err) {
    logger.error('Greška pri slanju podsetnika za porez:', err);
  }
}
