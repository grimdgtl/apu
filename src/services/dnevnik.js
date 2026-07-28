import { Client } from '@notionhq/client';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { danasISO, imeDana } from './checklist.js';

/**
 * Dnevnik (Notion baza na Life stranici) — kratak zapis po danu.
 *
 * Kolone: Dan (naslov), Datum, Raspoloženje (select), Energija (select),
 * Ključna reč (tekst) i veza `Checklista` ka dnevnoj checklisti.
 */

export const RASPOLOZENJA = ['Odlično', 'Dobro', 'Neutralno', 'Loše', 'Teško'];
export const ENERGIJE = ['Visoka', 'Srednja', 'Niska'];

let client = null;
function getClient() {
  if (!featureEnabled.dnevnik) {
    throw new Error('Dnevnik nije podešen (NOTION_DNEVNIK_DB_ID nedostaje).');
  }
  if (!client) client = new Client({ auth: config.notion.apiKey });
  return client;
}

function redUObjekat(page) {
  const p = page.properties;
  const raspolozenje = p['Raspoloženje']?.select?.name ?? null;
  const energija = p['Energija']?.select?.name ?? null;
  const kljucnaRec = (p['Ključna reč']?.rich_text || []).map((t) => t.plain_text).join('') || null;

  // Šta je još prazno — bot na osnovu ovoga pita korisnika za ostalo.
  const prazno = [];
  if (!raspolozenje) prazno.push('Raspoloženje');
  if (!energija) prazno.push('Energija');
  if (!kljucnaRec) prazno.push('Ključna reč');

  return {
    id: page.id,
    url: page.url,
    dan: (p.Dan?.title || []).map((t) => t.plain_text).join(''),
    datum: p.Datum?.date?.start ?? null,
    raspolozenje,
    energija,
    kljucnaRec,
    prazno,
    popunjen: prazno.length === 0,
  };
}

/** Nalazi zapis za dati datum (ili null). */
export async function nadjiRed(datum = danasISO()) {
  const res = await getClient().databases.query({
    database_id: config.notion.dnevnikDbId,
    filter: { property: 'Datum', date: { equals: datum } },
    page_size: 1,
  });
  return res.results.length ? redUObjekat(res.results[0]) : null;
}

/**
 * Kreira prazan zapis za dati datum. Idempotentno.
 * @param {string} [datum]
 * @param {string} [checklistPageId] ako je dat, poveže zapis sa redom checkliste
 */
export async function kreirajRed(datum = danasISO(), checklistPageId = null) {
  const postojeci = await nadjiRed(datum);
  if (postojeci) {
    logger.info(`Dnevnik: zapis za ${datum} već postoji — preskačem.`);
    return { ...postojeci, većPostojao: true };
  }

  const properties = {
    Dan: { title: [{ text: { content: imeDana(datum) } }] },
    Datum: { date: { start: datum } },
  };
  if (checklistPageId) {
    properties['Checklista'] = { relation: [{ id: checklistPageId }] };
  }

  const page = await getClient().pages.create({
    parent: { database_id: config.notion.dnevnikDbId },
    properties,
  });

  logger.info(`Dnevnik: kreiran zapis za ${datum} (${imeDana(datum)}).`);
  return { ...redUObjekat(page), većPostojao: false };
}

/**
 * Upisuje raspoloženje / energiju / ključnu reč. Ako zapis ne postoji — kreira ga.
 * Vraća i listu polja koja su i dalje prazna, da bi bot mogao da pita za ostalo.
 */
export async function upisi({ datum = danasISO(), raspolozenje, energija, kljucnaRec }) {
  if (raspolozenje && !RASPOLOZENJA.includes(raspolozenje)) {
    throw new Error(`Nepoznato raspoloženje "${raspolozenje}". Dozvoljeno: ${RASPOLOZENJA.join(', ')}.`);
  }
  if (energija && !ENERGIJE.includes(energija)) {
    throw new Error(`Nepoznata energija "${energija}". Dozvoljeno: ${ENERGIJE.join(', ')}.`);
  }

  let red = await nadjiRed(datum);
  if (!red) red = await kreirajRed(datum);

  const properties = {};
  if (raspolozenje) properties['Raspoloženje'] = { select: { name: raspolozenje } };
  if (energija) properties['Energija'] = { select: { name: energija } };
  if (kljucnaRec) properties['Ključna reč'] = { rich_text: [{ text: { content: kljucnaRec } }] };

  if (Object.keys(properties).length === 0) return red;

  const page = await getClient().pages.update({ page_id: red.id, properties });
  const azuriran = redUObjekat(page);

  logger.info(
    `Dnevnik ${datum}: upisano (${Object.keys(properties).join(', ')}); ` +
      `još prazno: ${azuriran.prazno.join(', ') || 'ništa'}.`,
  );
  return azuriran;
}

/** Stanje zapisa za dati datum. */
export async function stanje(datum = danasISO()) {
  const red = await nadjiRed(datum);
  if (!red) {
    return { datum, dan: imeDana(datum), postoji: false, popunjen: false, prazno: ['sve'] };
  }
  return { ...red, postoji: true };
}
