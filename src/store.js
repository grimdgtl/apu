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
 * Ime state fajla sme da bude samo prost naziv — bez separatora i tačaka, da
 * `name` nikad ne može da izađe iz DATA_DIR-a (npr. "../../etc/nesto").
 * Sva pozivna mesta koriste konstante, ali granicu držimo ovde da ostane
 * tačna i ako neko sutra prosledi vrednost iz poruke ili alata.
 */
function stateFile(name) {
  if (typeof name !== 'string' || !/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error(`Nedozvoljeno ime stanja: "${name}".`);
  }
  return path.join(DATA_DIR, `${name}.json`);
}

/**
 * Generičko čuvanje malog stanja u DATA_DIR/<name>.json.
 * Koristi se npr. za pamćenje o kojim je mejlovima već javljeno.
 */
export function loadState(name, fallback = null) {
  try {
    const file = stateFile(name);
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
    const file = stateFile(name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.error(`Ne mogu da sačuvam stanje "${name}":`, err.message);
  }
}

// Red čekanja po fajlu — serijalizuje čitaj-izmeni-upiši cikluse.
const redovi = new Map();

/**
 * Bezbedna izmena stanja: učita, pusti `izmeni` da vrati novu vrednost, upiše.
 *
 * Obično `loadState` + `saveState` iz dva posla koja se poklope (u 10:00 idu i
 * provera sajtova i provera mejlova) mogu da pregaze jedan drugom zapis — oba
 * pročitaju isto stanje, pa drugi upis poništi prvi. Ovde se pozivi za isti
 * fajl nižu jedan za drugim, pa se ništa ne gubi.
 *
 * @param {string} name      ime state fajla
 * @param {Function} izmeni  (trenutno) => novo stanje; sme biti async
 * @param {*} fallback       vrednost kad fajl još ne postoji
 */
export function updateState(name, izmeni, fallback = null) {
  const prethodni = redovi.get(name) ?? Promise.resolve();

  const sledeci = prethodni.then(async () => {
    const trenutno = loadState(name, fallback);
    const novo = await izmeni(trenutno);
    if (novo !== undefined) saveState(name, novo);
    return novo;
  });

  // Greška jednog upisa ne sme da zaglavi red za sve naredne.
  redovi.set(
    name,
    sledeci.catch(() => {}),
  );
  return sledeci;
}
