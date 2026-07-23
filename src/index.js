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
  logger.info('Aktivne integracije:', {
    notion: featureEnabled.notion,
    calendar: featureEnabled.calendar,
    mail: featureEnabled.mail,
  });

  startScheduler();

  await bot.launch();
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
