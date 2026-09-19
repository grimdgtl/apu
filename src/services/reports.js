import { featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { generateText } from './claude.js';
import * as notion from './notion.js';
import * as calendar from './calendar.js';
import { createDoc } from './drive.js';
import { checkAllSites, formatReport } from './monitor.js';

/**
 * Generisanje izveštaja — skuplja podatke iz dostupnih izvora (Notion zadaci,
 * Google Calendar, monitoring sajtova), sastavlja uredan izveštaj na srpskom
 * i (opciono) čuva ga kao Google Doc. Jedan poziv umesto ručnog kombinovanja
 * više alata.
 */

/** Parsira "YYYY-MM-DD" ili ISO string u Date; vraća null ako ne uspe. */
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} opts
 * @param {string} [opts.title] Naslov izveštaja (default: "Izveštaj <datum>").
 * @param {string} [opts.instructions] Šta izveštaj treba da obuhvati / naglasi.
 * @param {string} [opts.from] ISO/date početak opsega za kalendar (default: pre 7 dana).
 * @param {string} [opts.to] ISO/date kraj opsega za kalendar (default: danas).
 * @param {boolean} [opts.includeTasks=true] Uključi Notion zadatke.
 * @param {boolean} [opts.includeCalendar=true] Uključi kalendar u opsegu.
 * @param {boolean} [opts.includeSites=false] Uključi status sajtova.
 * @param {boolean} [opts.saveToDoc=true] Sačuvaj kao Google Doc.
 */
export async function generateReport(opts = {}) {
  const {
    title,
    instructions = '',
    includeTasks = true,
    includeCalendar = true,
    includeSites = false,
    saveToDoc = true,
  } = opts;

  const now = new Date();
  const to = parseDate(opts.to) || now;
  const from = parseDate(opts.from) || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const parts = [];

  if (includeTasks && featureEnabled.notionTasks) {
    const [notStarted, inProgress, done] = await Promise.all([
      notion.listTasks({ status: 'Not started', limit: 50 }),
      notion.listTasks({ status: 'In progress', limit: 50 }),
      notion.listTasks({ status: 'Done', limit: 50 }),
    ]);
    parts.push(
      `ZADACI:\n` +
        `- Završeni (Done): ${JSON.stringify(done.map((t) => t.title))}\n` +
        `- U toku (In progress): ${JSON.stringify(inProgress.map((t) => t.title))}\n` +
        `- Za uraditi (Not started): ${JSON.stringify(notStarted.map((t) => t.title))}`,
    );
  }

  if (includeCalendar && featureEnabled.calendar) {
    const events = await calendar.listEvents({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
    });
    parts.push(
      `KALENDAR (${from.toISOString().slice(0, 10)} – ${to.toISOString().slice(0, 10)}):\n` +
        JSON.stringify(events, null, 2),
    );
  }

  if (includeSites && featureEnabled.siteMonitor) {
    const data = await checkAllSites();
    parts.push(`STATUS SAJTOVA:\n${formatReport(data, true)}`);
  }

  if (parts.length === 0) {
    throw new Error(
      'Nema dostupnih podataka za izveštaj (proveri da su Notion/Calendar/monitoring podešeni).',
    );
  }

  const docTitle = title || `Izveštaj ${now.toISOString().slice(0, 10)}`;
  const raw = parts.join('\n\n');

  const content = await generateText(
    `Sastavi uredan, profesionalan izveštaj na srpskom, latinicom, pod naslovom "${docTitle}". ` +
      `Organizuj ga u jasne sekcije sa naslovima, koristi liste gde ima smisla, i na kraju ` +
      `dodaj kratak zaključak/preporuke. Ne izmišljaj podatke — koristi samo ono što je dato. ` +
      (instructions ? `Poseban zahtev: ${instructions}\n\n` : '\n') +
      `PODACI:\n${raw}`,
  );

  const result = { title: docTitle, content };

  if (saveToDoc && featureEnabled.reports) {
    const doc = await createDoc({ name: docTitle, content });
    result.doc = { id: doc.id, name: doc.name, link: doc.link };
    logger.info(`Izveštaj sačuvan u Google Doc: ${doc.link}`);
  }

  return result;
}
