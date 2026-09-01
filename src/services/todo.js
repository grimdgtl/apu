import { Client } from '@notionhq/client';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { danasISO, nedeljaOko } from './checklist.js';

/**
 * To-do lista (Notion baza na Life stranici) — lični zadaci.
 *
 * Kolone: Zadatak (naslov), Status, Oblast, Prioritet, Rok.
 * Pored običnih zadataka, ovde živi i nedeljni zadatak koji se sam kreira na
 * početku svake nedelje (naslov se zadaje preko WEEKLY_TASK_TITLE).
 */

export const OBLASTI = ['Zdravlje', 'Kuća', 'Finansije', 'Ljudi', 'Učenje', 'Ostalo'];
export const PRIORITETI = ['Visok', 'Srednji', 'Nizak'];
export const STATUSI = ['Not started', 'In progress', 'Done'];

/** Naslov nedeljnog zadatka — po njemu se prepoznaje da već postoji. */
export const NEDELJNI_ZADATAK = config.nedeljniZadatak;

let client = null;
function getClient() {
  if (!featureEnabled.todo) {
    throw new Error('To-do lista nije podešena (NOTION_TODO_DB_ID nedostaje).');
  }
  if (!client) client = new Client({ auth: config.notion.apiKey });
  return client;
}

function redUObjekat(page) {
  const p = page.properties;
  return {
    id: page.id,
    url: page.url,
    zadatak: (p.Zadatak?.title || []).map((t) => t.plain_text).join(''),
    status: p.Status?.status?.name ?? null,
    oblast: p.Oblast?.select?.name ?? null,
    prioritet: p.Prioritet?.select?.name ?? null,
    rok: p.Rok?.date?.start ?? null,
  };
}

/** Lista zadataka; podrazumevano samo otvoreni (ne "Done"). */
export async function lista({ status, samoOtvoreni = true, limit = 25 } = {}) {
  const filter = status
    ? { property: 'Status', status: { equals: status } }
    : samoOtvoreni
      ? { property: 'Status', status: { does_not_equal: 'Done' } }
      : undefined;

  const res = await getClient().databases.query({
    database_id: config.notion.todoDbId,
    page_size: limit,
    ...(filter ? { filter } : {}),
  });

  return res.results.map(redUObjekat);
}

/** Dodaje nov zadatak. */
export async function dodaj({ zadatak, oblast, prioritet, rok }) {
  if (oblast && !OBLASTI.includes(oblast)) {
    throw new Error(`Nepoznata oblast "${oblast}". Dozvoljeno: ${OBLASTI.join(', ')}.`);
  }
  if (prioritet && !PRIORITETI.includes(prioritet)) {
    throw new Error(`Nepoznat prioritet "${prioritet}". Dozvoljeno: ${PRIORITETI.join(', ')}.`);
  }

  const properties = {
    Zadatak: { title: [{ text: { content: zadatak } }] },
    Status: { status: { name: 'Not started' } },
  };
  if (oblast) properties.Oblast = { select: { name: oblast } };
  if (prioritet) properties.Prioritet = { select: { name: prioritet } };
  if (rok) properties.Rok = { date: { start: rok } };

  const page = await getClient().pages.create({
    parent: { database_id: config.notion.todoDbId },
    properties,
  });

  logger.info(`To-do: dodat zadatak "${zadatak}".`);
  return redUObjekat(page);
}

/** Menja status zadatka (npr. na "Done"). */
export async function promeniStatus({ zadatakId, status }) {
  if (!STATUSI.includes(status)) {
    throw new Error(`Nepoznat status "${status}". Dozvoljeno: ${STATUSI.join(', ')}.`);
  }
  const page = await getClient().pages.update({
    page_id: zadatakId,
    properties: { Status: { status: { name: status } } },
  });
  logger.info(`To-do: zadatak ${zadatakId} → ${status}.`);
  return redUObjekat(page);
}

// ------------------------------------------------- nedeljni zadatak ---

/**
 * Traži nedeljni zadatak u nedelji koja sadrži dati datum.
 */
export async function nadjiNedeljni(datum = danasISO()) {
  const { start, end } = nedeljaOko(datum);
  const res = await getClient().databases.query({
    database_id: config.notion.todoDbId,
    filter: {
      and: [
        { property: 'Zadatak', title: { contains: NEDELJNI_ZADATAK } },
        { property: 'Rok', date: { on_or_after: start } },
        { property: 'Rok', date: { on_or_before: end } },
      ],
    },
    page_size: 1,
  });
  return res.results.length ? redUObjekat(res.results[0]) : null;
}

/**
 * Kreira nedeljni zadatak (rok = nedelja te sedmice). Idempotentno.
 */
export async function kreirajNedeljni(datum = danasISO()) {
  const postojeci = await nadjiNedeljni(datum);
  if (postojeci) {
    logger.info('To-do: nedeljni zadatak za ovu nedelju već postoji — preskačem.');
    return { ...postojeci, većPostojao: true };
  }

  const { end } = nedeljaOko(datum);
  const zadatak = await dodaj({
    zadatak: NEDELJNI_ZADATAK,
    oblast: 'Ljudi',
    prioritet: 'Srednji',
    rok: end,
  });

  logger.info(`To-do: kreiran nedeljni zadatak (rok ${end}).`);
  return { ...zadatak, većPostojao: false };
}
