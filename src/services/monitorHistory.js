import { loadState, saveState } from '../store.js';
import { logger } from '../logger.js';

/**
 * Istorija provera sajtova.
 *
 * Do sada se svaka provera radila i rezultat bacao — nije se moglo reći ni
 * "koliko je puta ovaj sajt pao ovog meseca", a kamoli dati klijentu uptime.
 * Ovde se svaka provera upisuje na disk, pa se iz toga računa dostupnost.
 *
 * Fajl: DATA_DIR/monitor-history.json
 * Oblik: [{ vreme, sajt, url, ok, status, ms, greska }]
 *
 * Čuva se ograničen broj zapisa (rotacija) da fajl ne raste bez kraja:
 * 20 sajtova × 2 provere dnevno × 180 dana ≈ 7200 zapisa.
 */

const FILE = 'monitor-history';
const MAX_ZAPISA = 8000;

function ucitaj() {
  const raw = loadState(FILE, []);
  return Array.isArray(raw) ? raw : [];
}

/**
 * Upisuje rezultate jedne provere (svih sajtova odjednom).
 * @param {Array} rezultati izlaz iz checkAllSites().results
 */
export function zabelezi(rezultati) {
  if (!Array.isArray(rezultati) || rezultati.length === 0) return { upisano: 0 };

  const vreme = new Date().toISOString();
  const zapisi = ucitaj();

  for (const r of rezultati) {
    zapisi.push({
      vreme,
      sajt: r.name,
      url: r.url,
      ok: Boolean(r.ok),
      status: r.status ?? null,
      ms: r.ms ?? null,
      greska: r.error ?? null,
    });
  }

  // Rotacija — zadrži najnovijih MAX_ZAPISA.
  const visak = zapisi.length - MAX_ZAPISA;
  const konacni = visak > 0 ? zapisi.slice(visak) : zapisi;

  saveState(FILE, konacni);
  logger.debug(`Monitor istorija: upisano ${rezultati.length} zapisa (ukupno ${konacni.length}).`);
  return { upisano: rezultati.length, ukupno: konacni.length };
}

/**
 * Uptime po sajtu za poslednjih N dana.
 * @param {object} [opts]
 * @param {number} [opts.dana] period (default 30)
 * @param {string} [opts.sajt] filtriraj na jedan sajt (podniz imena)
 */
export function uptime({ dana = 30, sajt } = {}) {
  const granica = new Date(Date.now() - dana * 24 * 60 * 60 * 1000).toISOString();
  let zapisi = ucitaj().filter((z) => z.vreme >= granica);

  if (sajt) {
    const needle = sajt.toLowerCase();
    zapisi = zapisi.filter((z) => (z.sajt || '').toLowerCase().includes(needle));
  }

  if (zapisi.length === 0) {
    return {
      dana,
      brojProvera: 0,
      poruka: 'Nema zabeleženih provera za taj period (istorija se skuplja od prve provere).',
      sajtovi: [],
    };
  }

  const poSajtu = new Map();
  for (const z of zapisi) {
    const s = poSajtu.get(z.sajt) ?? { sajt: z.sajt, url: z.url, provera: 0, ok: 0, padovi: [] };
    s.provera += 1;
    if (z.ok) s.ok += 1;
    else s.padovi.push({ vreme: z.vreme, greska: z.greska, status: z.status });
    s.url = z.url ?? s.url;
    poSajtu.set(z.sajt, s);
  }

  const sajtovi = [...poSajtu.values()]
    .map((s) => ({
      sajt: s.sajt,
      url: s.url,
      provera: s.provera,
      uspesnih: s.ok,
      uptime: Number(((s.ok / s.provera) * 100).toFixed(2)),
      brojPadova: s.padovi.length,
      poslednjiPad: s.padovi.length ? s.padovi[s.padovi.length - 1] : null,
    }))
    .sort((a, b) => a.uptime - b.uptime); // najproblematičniji prvi

  const ukupnoProvera = sajtovi.reduce((n, s) => n + s.provera, 0);
  const ukupnoOk = sajtovi.reduce((n, s) => n + s.uspesnih, 0);

  return {
    dana,
    odDatuma: granica.slice(0, 10),
    brojProvera: ukupnoProvera,
    ukupanUptime: Number(((ukupnoOk / ukupnoProvera) * 100).toFixed(2)),
    sajtovi,
  };
}

/** Broj zapisa u istoriji (za /status). */
export function brojZapisa() {
  return ucitaj().length;
}
