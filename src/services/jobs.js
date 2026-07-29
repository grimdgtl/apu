import { loadState, updateState } from '../store.js';
import { logger } from '../logger.js';
import { sendMessage } from './telegram.js';

/**
 * Omotač za zakazane poslove: ponavljanje pokušaja + evidencija izvršavanja.
 *
 * Do sada je pad posla bio nevidljiv — ako Notion zabrlja u 5:00, red se ne
 * napravi, a ti to primetiš tek po odsustvu poruke. Sada:
 *   - neuspeo posao se ponavlja nekoliko puta sa rastućim razmakom,
 *   - svako izvršavanje se beleži, pa se može pitati "da li sve radi".
 *
 * Fajl: DATA_DIR/job-runs.json
 */

const FILE = 'job-runs';
const MAX_ZAPISA = 500;

function ucitaj() {
  const raw = loadState(FILE, []);
  return Array.isArray(raw) ? raw : [];
}

// Više poslova ume da se poklopi u istom minutu (u 10:00 idu i provera
// sajtova i provera mejlova), pa upis ide kroz updateState da jedan zapis ne
// pregazi drugi.
function zabelezi(zapis) {
  return updateState(
    FILE,
    (trenutno) => {
      const zapisi = Array.isArray(trenutno) ? [...trenutno, zapis] : [zapis];
      const visak = zapisi.length - MAX_ZAPISA;
      return visak > 0 ? zapisi.slice(visak) : zapisi;
    },
    [],
  );
}

const cekaj = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pokreće posao sa ponavljanjem i beleži ishod.
 *
 * @param {string} naziv     čitljivo ime posla (ide u evidenciju)
 * @param {Function} posao   async funkcija
 * @param {object} [opts]
 * @param {number} [opts.pokusaja]  ukupan broj pokušaja (default 3)
 * @param {number} [opts.pauzaMs]   početna pauza; udvostručuje se (default 30s)
 */
export async function pokreni(naziv, posao, { pokusaja = 3, pauzaMs = 30_000 } = {}) {
  const pocetak = Date.now();
  let greska = null;

  for (let pokusaj = 1; pokusaj <= pokusaja; pokusaj++) {
    try {
      const rezultat = await posao();
      await zabelezi({
        naziv,
        vreme: new Date().toISOString(),
        uspeh: true,
        pokusaj,
        trajanjeMs: Date.now() - pocetak,
        greska: null,
      });
      if (pokusaj > 1) logger.info(`Posao "${naziv}" uspeo iz ${pokusaj}. pokušaja.`);
      return rezultat;
    } catch (err) {
      greska = err;
      const poslednji = pokusaj === pokusaja;
      logger.error(
        `Posao "${naziv}" pao (pokušaj ${pokusaj}/${pokusaja}): ${err.message}` +
          (poslednji ? '' : ` — ponavljam za ${Math.round(pauzaMs / 1000)}s`),
      );
      if (!poslednji) {
        await cekaj(pauzaMs);
        pauzaMs *= 2;
      }
    }
  }

  await zabelezi({
    naziv,
    vreme: new Date().toISOString(),
    uspeh: false,
    pokusaj: pokusaja,
    trajanjeMs: Date.now() - pocetak,
    greska: greska?.message ?? 'nepoznata greška',
  });

  // Tek sada javi — da ne diže paniku zbog prolaznog prekida mreže.
  await sendMessage(
    `⚠️ Posao "${naziv}" nije uspeo ni iz ${pokusaja} pokušaja.\n\n` +
      `Greška: ${greska?.message ?? 'nepoznata'}`,
  ).catch(() => {});

  return null;
}

/**
 * Pregled izvršavanja poslova za poslednjih N sati.
 * Vraća po poslu: broj pokretanja, uspeha, poslednje vreme i poslednju grešku.
 */
export function pregled({ sati = 24 } = {}) {
  const granica = new Date(Date.now() - sati * 60 * 60 * 1000).toISOString();
  const zapisi = ucitaj().filter((z) => z.vreme >= granica);

  if (zapisi.length === 0) {
    return { sati, ukupno: 0, poslovi: [], poruka: 'Nema zabeleženih pokretanja u tom periodu.' };
  }

  const poNazivu = new Map();
  for (const z of zapisi) {
    const p = poNazivu.get(z.naziv) ?? {
      naziv: z.naziv,
      pokretanja: 0,
      uspeha: 0,
      poslednje: null,
      poslednjaGreska: null,
    };
    p.pokretanja += 1;
    if (z.uspeh) p.uspeha += 1;
    else p.poslednjaGreska = z.greska;
    if (!p.poslednje || z.vreme > p.poslednje) p.poslednje = z.vreme;
    poNazivu.set(z.naziv, p);
  }

  const poslovi = [...poNazivu.values()]
    .map((p) => ({ ...p, neuspeha: p.pokretanja - p.uspeha }))
    .sort((a, b) => b.neuspeha - a.neuspeha);

  return {
    sati,
    ukupno: zapisi.length,
    neuspesnih: zapisi.filter((z) => !z.uspeh).length,
    poslovi,
  };
}

/** Kratak tekst za Telegram (koristi ga /poslovi i dnevni pregled). */
export function formatiraj(p) {
  if (p.ukupno === 0) return `Poslovi: ${p.poruka}`;

  const redovi = p.poslovi.map((x) => {
    const oznaka = x.neuspeha === 0 ? 'OK' : `${x.neuspeha} greška(e)`;
    const kada = x.poslednje ? new Date(x.poslednje).toLocaleString('sr-RS') : '-';
    const greska = x.poslednjaGreska ? `\n    poslednja greška: ${x.poslednjaGreska}` : '';
    return `• ${x.naziv}: ${x.uspeha}/${x.pokretanja} ${oznaka}\n    poslednje: ${kada}${greska}`;
  });

  const naslov =
    p.neuspesnih === 0
      ? `Svi poslovi u poslednjih ${p.sati}h su prošli (${p.ukupno} pokretanja).`
      : `Poslovi u poslednjih ${p.sati}h: ${p.neuspesnih} neuspeha od ${p.ukupno} pokretanja.`;

  return `${naslov}\n\n${redovi.join('\n')}`;
}
