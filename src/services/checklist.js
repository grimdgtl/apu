import { Client } from '@notionhq/client';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';

/**
 * Dnevna checklista (Notion baza na Life stranici).
 *
 * Svaki red je jedan dan: naslov `Dan` (npr. "Sreda"), datum `Datum`, pa
 * checkbox navike i formula `Skor`.
 *
 * ⚠️ Stavke koje počinju sa "Bez " su OBRNUTE: čekirano znači da si USPEŠNO
 * izbegao tu stvar. "Nisam pio kolu" → `Bez kole` = true.
 *
 * Nazivi stavki dolaze iz .env (CHECKLIST_POZITIVNE / CHECKLIST_IZBEGAVANJA)
 * jer MORAJU doslovno odgovarati kolonama u tvojoj Notion bazi.
 */

// Kanonska imena kolona — model ne sme da izmišlja svoja.
export const POZITIVNE = config.checklist.pozitivne;
export const IZBEGAVANJA = config.checklist.izbegavanja;
export const SVE_STAVKE = [...POZITIVNE, ...IZBEGAVANJA];

const GYM = config.checklist.ciljnaStavka;
const DANI = ['Nedelja', 'Ponedeljak', 'Utorak', 'Sreda', 'Četvrtak', 'Petak', 'Subota'];

let client = null;
function getClient() {
  if (!featureEnabled.checklist) {
    throw new Error('Dnevna checklista nije podešena (NOTION_CHECKLIST_DB_ID nedostaje).');
  }
  if (!client) client = new Client({ auth: config.notion.apiKey });
  return client;
}

/** Datum "danas" u korisnikovoj vremenskoj zoni, kao YYYY-MM-DD. */
export function danasISO() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone }).format(new Date());
}

/** Ime dana u nedelji na srpskom za dati ISO datum. */
export function imeDana(iso) {
  return DANI[new Date(`${iso}T12:00:00`).getDay()];
}

/** Ponedeljak–nedelja opseg koji sadrži dati datum. */
export function nedeljaOko(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const pomeraj = (d.getDay() + 6) % 7; // 0 = ponedeljak
  const start = new Date(d);
  start.setDate(d.getDate() - pomeraj);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

function redUObjekat(page) {
  const p = page.properties;
  const stavke = {};
  for (const naziv of SVE_STAVKE) {
    stavke[naziv] = p[naziv]?.checkbox ?? false;
  }
  return {
    id: page.id,
    url: page.url,
    dan: (p.Dan?.title || []).map((t) => t.plain_text).join(''),
    datum: p.Datum?.date?.start ?? null,
    stavke,
    urađeno: Object.values(stavke).filter(Boolean).length,
    ukupno: SVE_STAVKE.length,
  };
}

/** Pronalazi red za dati datum (ili null). */
export async function nadjiRed(datum = danasISO()) {
  const res = await getClient().databases.query({
    database_id: config.notion.checklistDbId,
    filter: { property: 'Datum', date: { equals: datum } },
    page_size: 1,
  });
  return res.results.length ? redUObjekat(res.results[0]) : null;
}

/**
 * Kreira red za dati datum. Ako već postoji, vraća postojeći (bez duplikata).
 */
export async function kreirajRed(datum = danasISO()) {
  const postojeci = await nadjiRed(datum);
  if (postojeci) {
    logger.info(`Checklista: red za ${datum} već postoji — preskačem.`);
    return { ...postojeci, većPostojao: true };
  }

  const page = await getClient().pages.create({
    parent: { database_id: config.notion.checklistDbId },
    properties: {
      Dan: { title: [{ text: { content: imeDana(datum) } }] },
      Datum: { date: { start: datum } },
    },
  });

  logger.info(`Checklista: kreiran red za ${datum} (${imeDana(datum)}).`);
  return { ...redUObjekat(page), većPostojao: false };
}

/**
 * Čekira/odčekira stavke za dati datum. Ako red ne postoji — napravi ga.
 * @param {object} opts
 * @param {Record<string, boolean>} opts.stavke npr. { "Doručak": true, "Bez slatkog": true }
 * @param {string} [opts.datum] YYYY-MM-DD (default: danas)
 */
export async function oznaci({ stavke, datum = danasISO() }) {
  const nepoznate = Object.keys(stavke).filter((k) => !SVE_STAVKE.includes(k));
  if (nepoznate.length) {
    throw new Error(
      `Nepoznate stavke: ${nepoznate.join(', ')}. Dozvoljeno: ${SVE_STAVKE.join(', ')}.`,
    );
  }

  let red = await nadjiRed(datum);
  if (!red) red = await kreirajRed(datum);

  const properties = {};
  for (const [naziv, vrednost] of Object.entries(stavke)) {
    properties[naziv] = { checkbox: Boolean(vrednost) };
  }

  const page = await getClient().pages.update({ page_id: red.id, properties });
  const azuriran = redUObjekat(page);

  logger.info(
    `Checklista ${datum}: označeno ${Object.keys(stavke).join(', ')} ` +
      `(skor ${azuriran.urađeno}/${azuriran.ukupno}).`,
  );
  return azuriran;
}

/**
 * Vraća stanje za dati datum + šta još fali + napredak teretane ove nedelje.
 */
export async function stanje(datum = danasISO()) {
  const red = await nadjiRed(datum);
  const teretana = await teretanaOveNedelje(datum);

  if (!red) {
    return {
      datum,
      dan: imeDana(datum),
      postoji: false,
      poruka: 'Red za taj datum još ne postoji.',
      teretana,
    };
  }

  return {
    ...red,
    postoji: true,
    fali: SVE_STAVKE.filter((s) => !red.stavke[s]),
    teretana,
  };
}

/**
 * Broji odlaske u teretanu u nedelji (pon–ned) koja sadrži dati datum.
 * Cilj je minimum 3 puta.
 */
export async function teretanaOveNedelje(datum = danasISO()) {
  const { start, end } = nedeljaOko(datum);
  const res = await getClient().databases.query({
    database_id: config.notion.checklistDbId,
    filter: {
      and: [
        { property: 'Datum', date: { on_or_after: start } },
        { property: 'Datum', date: { on_or_before: end } },
        { property: GYM, checkbox: { equals: true } },
      ],
    },
    page_size: 10,
  });

  const bilo = res.results.length;
  const cilj = config.checklist.ciljNedeljno;
  return {
    odPonedeljka: start,
    doNedelje: end,
    bilo,
    cilj,
    ostalo: Math.max(0, cilj - bilo),
    ispunjen: bilo >= cilj,
  };
}

/**
 * Nedeljni rezime (pon–ned): koliko je dana popunjeno, prosečan skor i teretana.
 * Koristi ga nedeljna pohvala u nedelju uveče.
 */
export async function nedeljniRezime(datum = danasISO()) {
  const { start, end } = nedeljaOko(datum);
  const res = await getClient().databases.query({
    database_id: config.notion.checklistDbId,
    filter: {
      and: [
        { property: 'Datum', date: { on_or_after: start } },
        { property: 'Datum', date: { on_or_before: end } },
      ],
    },
    page_size: 10,
  });

  const dani = res.results.map(redUObjekat);
  const ukupnoStavki = dani.reduce((s, d) => s + d.urađeno, 0);
  const maksimum = dani.length * SVE_STAVKE.length;
  const procenat = maksimum ? Math.round((ukupnoStavki / maksimum) * 100) : 0;
  const najbolji = dani.slice().sort((a, b) => b.urađeno - a.urađeno)[0] ?? null;

  return {
    odPonedeljka: start,
    doNedelje: end,
    brojDana: dani.length,
    ukupnoStavki,
    maksimum,
    procenat,
    najboljiDan: najbolji ? { dan: najbolji.dan, skor: najbolji.urađeno } : null,
    teretana: await teretanaOveNedelje(datum),
  };
}
