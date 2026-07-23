import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Trajno čuvanje istorije razgovora na disk.
 *
 * Bez ovoga se pamćenje gubi pri svakom restartu kontejnera (redeploy,
 * health-check restart, pad procesa). Fajl ide u DATA_DIR — na serveru
 * to treba da bude persistent volume, inače opet gubiš istoriju.
 */

const DATA_DIR = process.env.DATA_DIR || './data';
const FILE = path.join(DATA_DIR, 'histories.json');

/**
 * Učitava istoriju sa diska. Ključ je chatId kao string.
 * @returns {Map<string, Array>}
 */
export function loadHistories() {
  try {
    if (!fs.existsSync(FILE)) {
      logger.info('Nema sačuvane istorije — krećem od nule.');
      return new Map();
    }
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const map = new Map(Object.entries(raw));
    logger.info(`Učitana istorija za ${map.size} chat(ova) iz ${FILE}`);
    return map;
  } catch (err) {
    logger.error('Ne mogu da učitam istoriju razgovora:', err.message);
    return new Map();
  }
}

/**
 * Snima istoriju na disk (atomično — prvo .tmp pa rename).
 * @param {Map<string, Array>} histories
 */
export function saveHistories(histories) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(histories)));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    logger.error('Ne mogu da sačuvam istoriju razgovora:', err.message);
  }
}
