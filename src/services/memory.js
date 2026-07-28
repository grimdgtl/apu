import { randomUUID } from 'node:crypto';
import { loadState, saveState } from '../store.js';
import { logger } from '../logger.js';

/**
 * Trajno pamćenje činjenica o korisniku.
 *
 * Istorija razgovora čuva samo poslednjih 12 razmena, pa se sve starije gubi.
 * Ovde žive stvari koje treba da važe zauvek: ko je ko, preferencije, kontekst
 * projekata. Činjenice se UBACUJU U SYSTEM PROMPT pri svakoj poruci — dakle
 * model ih uvek zna, ne mora da se seti da ih potraži alatom.
 *
 * Fajl: DATA_DIR/facts.json
 */

const FILE = 'facts';
const MAX_CINJENICA = 300; // gornja granica da system prompt ne naraste previše

export const KATEGORIJE = ['osoba', 'preferencija', 'projekat', 'navika', 'ostalo'];

function ucitaj() {
  const raw = loadState(FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function snimi(cinjenice) {
  saveState(FILE, cinjenice);
}

/** Sve činjenice, najnovije prvo. */
export function lista({ kategorija } = {}) {
  const sve = ucitaj();
  const filtrirane = kategorija ? sve.filter((c) => c.kategorija === kategorija) : sve;
  return filtrirane.slice().sort((a, b) => (b.azurirano ?? '').localeCompare(a.azurirano ?? ''));
}

/**
 * Upisuje novu činjenicu. Ako već postoji vrlo slična (isti tekst, bez obzira
 * na velika slova), ažurira postojeću umesto da pravi duplikat.
 */
export function zapamti({ tekst, kategorija = 'ostalo' }) {
  if (!tekst || !tekst.trim()) throw new Error('Prazna činjenica.');
  if (!KATEGORIJE.includes(kategorija)) {
    throw new Error(`Nepoznata kategorija "${kategorija}". Dozvoljeno: ${KATEGORIJE.join(', ')}.`);
  }

  const cinjenice = ucitaj();
  const normalizovan = tekst.trim().toLowerCase();
  const postojeca = cinjenice.find((c) => c.tekst.trim().toLowerCase() === normalizovan);

  if (postojeca) {
    postojeca.kategorija = kategorija;
    postojeca.azurirano = new Date().toISOString();
    snimi(cinjenice);
    logger.info(`Memorija: činjenica već postojala, osvežena — "${tekst}"`);
    return { ...postojeca, novo: false };
  }

  if (cinjenice.length >= MAX_CINJENICA) {
    throw new Error(
      `Dostignut limit od ${MAX_CINJENICA} činjenica. Obriši nepotrebne (memory_forget).`,
    );
  }

  const nova = {
    id: randomUUID().slice(0, 8),
    tekst: tekst.trim(),
    kategorija,
    dodato: new Date().toISOString(),
    azurirano: new Date().toISOString(),
  };
  cinjenice.push(nova);
  snimi(cinjenice);
  logger.info(`Memorija: zapamćeno [${kategorija}] "${tekst}"`);
  return { ...nova, novo: true };
}

/** Briše činjenicu po ID-u. */
export function zaboravi({ id }) {
  const cinjenice = ucitaj();
  const idx = cinjenice.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Nema činjenice sa ID "${id}".`);
  const [obrisana] = cinjenice.splice(idx, 1);
  snimi(cinjenice);
  logger.info(`Memorija: obrisano "${obrisana.tekst}"`);
  return { obrisano: obrisana.tekst };
}

/** Menja tekst/kategoriju postojeće činjenice. */
export function izmeni({ id, tekst, kategorija }) {
  const cinjenice = ucitaj();
  const c = cinjenice.find((x) => x.id === id);
  if (!c) throw new Error(`Nema činjenice sa ID "${id}".`);
  if (kategorija && !KATEGORIJE.includes(kategorija)) {
    throw new Error(`Nepoznata kategorija "${kategorija}".`);
  }
  if (tekst) c.tekst = tekst.trim();
  if (kategorija) c.kategorija = kategorija;
  c.azurirano = new Date().toISOString();
  snimi(cinjenice);
  logger.info(`Memorija: izmenjeno ${id} → "${c.tekst}"`);
  return c;
}

/**
 * Kompaktan blok za system prompt. Vraća prazan string ako nema činjenica,
 * da ne trošimo tokene bez potrebe.
 */
export function zaSystemPrompt() {
  const cinjenice = ucitaj();
  if (cinjenice.length === 0) return '';

  const poKategoriji = {};
  for (const c of cinjenice) {
    (poKategoriji[c.kategorija] ??= []).push(c);
  }

  const redovi = [];
  for (const kat of KATEGORIJE) {
    const grupa = poKategoriji[kat];
    if (!grupa?.length) continue;
    redovi.push(`${kat}:`);
    for (const c of grupa) redovi.push(`  - [${c.id}] ${c.tekst}`);
  }

  return (
    'Ovo znaš o korisniku iz ranijih razgovora (trajno zapamćeno). ' +
    'Koristi to prirodno, bez podsećanja da si "zapamtio". ' +
    'ID u uglastim zagradama koristi samo ako treba da izmeniš ili obrišeš činjenicu:\n' +
    redovi.join('\n')
  );
}

/** Broj zapamćenih činjenica (za /status). */
export function broj() {
  return ucitaj().length;
}
