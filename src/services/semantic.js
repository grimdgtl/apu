import { config, featureEnabled } from '../config.js';
import { logger, skrati } from '../logger.js';
import { loadState, saveState } from '../store.js';
import * as notion from './notion.js';
import * as drive from './drive.js';

/**
 * Semantička pretraga nad sopstvenim sadržajem (embeddings).
 *
 * Notion pretraga traži doslovnu reč. Ovde se tekst pretvara u vektor, pa se
 * traži po ZNAČENJU — "šta sam pisao o onom klijentu u proleće" nađe zapis i
 * kad nijedna reč nije pogođena.
 *
 * Ovo je jedina prava ML komponenta u sistemu, ali bez treniranja: koristi
 * gotov model za embeddings (OpenAI text-embedding-3-small, isti ključ kao
 * Whisper).
 *
 * Indeks: DATA_DIR/semantic-index.json
 * Oblik: [{ id, izvor, naslov, url, tekst, vektor, indeksirano }]
 */

const FILE = 'semantic-index';
const MODEL = 'text-embedding-3-small';
const MAX_TEKST = 2000; // koliko znakova po dokumentu šaljemo na embedding

function ucitaj() {
  const raw = loadState(FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function kljuc() {
  const k = config.transcription.openaiKey;
  if (!k) throw new Error('Semantička pretraga traži OPENAI_API_KEY.');
  return k;
}

/** Pretvara tekstove u vektore (batch poziv). */
async function embed(tekstovi) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${kljuc()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, input: tekstovi }),
    signal: AbortSignal.timeout(60000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Embeddings greška ${res.status}: ${data?.error?.message ?? 'nepoznata'}`);
  }
  return data.data.map((x) => x.embedding);
}

/** Kosinusna sličnost dva vektora. */
function slicnost(a, b) {
  let skalarni = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    skalarni += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return skalarni / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/** Skuplja dokumente iz svih dostupnih izvora. */
async function skupiDokumente() {
  const dokumenti = [];

  // Notion — stranice i baze do kojih integracija ima pristup.
  if (featureEnabled.notionSearch) {
    try {
      const hits = await notion.search({ query: '', limit: 25 });
      for (const h of hits) {
        if (h.type !== 'page') continue;
        let tekst = h.title;
        try {
          const sadrzaj = await notion.readPage({ pageId: h.id });
          if (sadrzaj.text) tekst = `${h.title}\n${sadrzaj.text}`;
        } catch {
          // stranica bez čitljivog sadržaja — ostaje samo naslov
        }
        dokumenti.push({
          id: `notion:${h.id}`,
          izvor: 'notion',
          naslov: h.title,
          url: h.url,
          tekst: tekst.slice(0, MAX_TEKST),
        });
      }
    } catch (err) {
      logger.error('Semantika: ne mogu da pročitam Notion:', err.message);
    }
  }

  // Google Drive — tekstualni dokumenti.
  if (featureEnabled.drive) {
    try {
      const fajlovi = await drive.searchFiles({ query: '', limit: 25 });
      for (const f of fajlovi) {
        if (!f.type?.includes('document')) continue;
        try {
          const sadrzaj = await drive.readFile({ fileId: f.id });
          dokumenti.push({
            id: `drive:${f.id}`,
            izvor: 'drive',
            naslov: f.name,
            url: f.link,
            tekst: `${f.name}\n${sadrzaj.content}`.slice(0, MAX_TEKST),
          });
        } catch {
          // preskoči nečitljiv fajl
        }
      }
    } catch (err) {
      logger.error('Semantika: ne mogu da pročitam Drive:', err.message);
    }
  }

  return dokumenti;
}

/**
 * Gradi/osvežava indeks. Dokumenti čiji se tekst nije promenio se preskaču,
 * pa ponovno indeksiranje ne troši ni vreme ni novac.
 */
export async function indeksiraj() {
  const postojeci = new Map(ucitaj().map((d) => [d.id, d]));
  const dokumenti = await skupiDokumente();

  if (dokumenti.length === 0) {
    return { indeksirano: 0, preskoceno: 0, ukupno: postojeci.size, poruka: 'Nema dokumenata.' };
  }

  const novi = dokumenti.filter((d) => postojeci.get(d.id)?.tekst !== d.tekst);
  const preskoceno = dokumenti.length - novi.length;

  if (novi.length > 0) {
    // Embeddings API prima više tekstova odjednom — šaljemo u grupama.
    const VELICINA = 50;
    for (let i = 0; i < novi.length; i += VELICINA) {
      const grupa = novi.slice(i, i + VELICINA);
      const vektori = await embed(grupa.map((d) => d.tekst));
      grupa.forEach((d, j) => {
        postojeci.set(d.id, { ...d, vektor: vektori[j], indeksirano: new Date().toISOString() });
      });
    }
  }

  // Izbaci dokumente kojih više nema u izvoru.
  const zivi = new Set(dokumenti.map((d) => d.id));
  for (const id of postojeci.keys()) {
    if (!zivi.has(id)) postojeci.delete(id);
  }

  saveState(FILE, [...postojeci.values()]);
  logger.info(
    `Semantika: indeksirano ${novi.length}, preskočeno ${preskoceno}, ukupno ${postojeci.size}.`,
  );
  return { indeksirano: novi.length, preskoceno, ukupno: postojeci.size };
}

/**
 * Traži po značenju. Vraća najsličnije dokumente sa ocenom sličnosti.
 */
export async function trazi({ upit, limit = 5 }) {
  const indeks = ucitaj();
  if (indeks.length === 0) {
    return {
      upit,
      rezultati: [],
      poruka: 'Indeks je prazan — prvo pokreni indeksiranje (semantic_reindex).',
    };
  }

  const [vektorUpita] = await embed([upit]);

  const rezultati = indeks
    .map((d) => ({
      naslov: d.naslov,
      izvor: d.izvor,
      url: d.url,
      odlomak: d.tekst.slice(0, 300),
      ocena: Number(slicnost(vektorUpita, d.vektor).toFixed(3)),
    }))
    .sort((a, b) => b.ocena - a.ocena)
    .slice(0, limit);

  logger.info(`Semantika: "${skrati(upit, 60)}" → ${rezultati.length} rezultata.`);
  return { upit, ukupnoUIndeksu: indeks.length, rezultati };
}

/** Stanje indeksa (za /status). */
export function stanje() {
  const indeks = ucitaj();
  const poIzvoru = {};
  for (const d of indeks) poIzvoru[d.izvor] = (poIzvoru[d.izvor] ?? 0) + 1;
  return { dokumenata: indeks.length, poIzvoru };
}
