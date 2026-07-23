import cron from 'node-cron';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { sendMessage } from './telegram.js';
import { generateText } from './claude.js';
import * as calendar from './calendar.js';
import * as notion from './notion.js';

/**
 * Scheduler — proaktivni podsetnici preko cron izraza.
 *
 *   1. Jutarnji pregled — svaki dan u 10:00.
 *   2. Podsetnik za porez — 14. u mesecu u 10:00.
 *
 * Cron izrazi i vremenska zona dolaze iz config-a.
 */

export function startScheduler() {
  const options = { timezone: config.timezone };

  cron.schedule(config.cron.morningBriefing, morningBriefing, options);
  logger.info(`Zakazan jutarnji pregled: "${config.cron.morningBriefing}" (${config.timezone})`);

  cron.schedule(config.cron.taxReminder, taxReminder, options);
  logger.info(`Zakazan podsetnik za porez: "${config.cron.taxReminder}" (${config.timezone})`);
}

/**
 * Skuplja današnje događaje i otvorene zadatke, pa traži od Claude-a lep pregled.
 */
async function morningBriefing() {
  logger.info('Pokrećem jutarnji pregled...');
  try {
    const parts = [];

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
        `Istakni sastanke po vremenu i najvažnije zadatke. Budi konkretan i sažet.\n\n${raw}`,
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
