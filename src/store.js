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

/**
 * Generičko čuvanje malog stanja u DATA_DIR/<name>.json.
 * Koristi se npr. za pamćenje o kojim je mejlovima već javljeno.
 */
export function loadState(name, fallback = null) {
  try {
    const file = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.error(`Ne mogu da učitam stanje "${name}":`, err.message);
    return fallback;
  }
}

export function saveState(name, data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, `${name}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.error(`Ne mogu da sačuvam stanje "${name}":`, err.message);
  }
}
