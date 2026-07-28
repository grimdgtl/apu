import { bot } from './services/telegram.js';
import { startScheduler } from './services/scheduler.js';
import { featureEnabled, config } from './config.js';
import { logger } from './logger.js';

/**
 * Glavni ulaz aplikacije:
 *   - pokreće Telegram bota (long polling),
 *   - pokreće scheduler (cron podsetnike),
 *   - loguje koje su integracije aktivne.
 */

async function main() {
  logger.info('Pokrećem APU — lični Telegram AI asistent...');
  logger.info(`Model: ${config.anthropic.model}`);
  // Nazivi se izvode iz samog featureEnabled — tako nijedna nova integracija
  // ne može da "ispadne" iz ispisa kad se doda (ranije se to desilo).
  const NAZIVI = {
    notionSearch: 'notionPretraga',
    notionTasks: 'notionZadaci',
    notionKb: 'notionKb',
    calendar: 'calendar',
    drive: 'drive',
    mail: 'mail',
    voice: 'glasovne',
    siteMonitor: 'monitoringSajtova',
    checklist: 'checklista',
    dnevnik: 'dnevnik',
    todo: 'todoLista',
    memory: 'pamcenje',
    weather: 'prognoza',
    reports: 'izvestaji',
  };

  const stanje = {};
  for (const [kljuc, vrednost] of Object.entries(featureEnabled)) {
    stanje[NAZIVI[kljuc] ?? kljuc] = vrednost;
  }
  logger.info('Aktivne integracije:', stanje);

  const iskljucene = Object.entries(stanje)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (iskljucene.length) {
    logger.warn(`Isključene integracije: ${iskljucene.join(', ')}`);
  }

  startScheduler();

  // bot.launch() se u Telegraf-u v4 razrešava tek kad se bot ZAUSTAVI,
  // pa ga NE await-ujemo (inače se sledeći red nikad ne izvrši). Greške
  // pojedinačnih poruka hvata bot.catch; ovde hvatamo samo fatalni start.
  bot.launch().catch((err) => {
    logger.error('Telegram launch nije uspeo:', err);
    process.exit(1);
  });
  logger.info('Telegram bot je pokrenut i sluša poruke. ✅');

  // Uredno gašenje.
  const stop = (signal) => {
    logger.info(`Primljen ${signal}, gasim bota...`);
    bot.stop(signal);
    process.exit(0);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatalna greška pri pokretanju:', err);
  process.exit(1);
});
