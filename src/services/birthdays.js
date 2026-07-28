import { config } from '../config.js';
import { logger } from '../logger.js';
import { loadState, saveState } from '../store.js';
import * as notion from './notion.js';

/**
 * Rođendani — podsetnici da ne zaboraviš da čestitaš.
 *
 *   11:00  javi ko danas slavi (sa odnosom, telefonom, idejom za poklon).
 *   19:00  ako još nisi rekao botu da si čestitao, podseti te.
 *
 * "Čestitao sam" se pamti u state.json (odvojeno od istorije razgovora, da
 * /reset ne pobriše zabeleške), po ključu godina-mesec-dan + ID osobe.
 */

// Ime fajla u DATA_DIR (state se čuva kao data/birthdays.json).
const STATE_NAME = 'birthdays';

/**
 * Današnji datum u KONFIGURISANOJ vremenskoj zoni (ne serverskoj).
 * Cron radi po config.timezone, pa i poređenje datuma mora tako.
 * @returns {{iso: string, year: number, month: number, day: number}}
 */
export function todayInTimezone() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const [year, month, day] = parts.split('-').map(Number);
  return { iso: parts, year, month, day };
}

/** Da li je godina prestupna. */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Da li osoba slavi na zadati dan.
 *
 * Poredimo samo mesec i dan (godina u Notion-u je godina rođenja). Rođeni
 * 29. februara se u neprestupnoj godini slave 28. februara — inače bi im
 * podsetnik preskočio tri od četiri godine.
 */
export function celebratesOn(person, today) {
  // Datum čitamo kao čist tekst "YYYY-MM-DD" — bez new Date(), da nas
  // vremenska zona ne pomeri za dan unazad/unapred.
  const [, m, d] = person.date.slice(0, 10).split('-').map(Number);
  if (m === today.month && d === today.day) return true;
  if (m === 2 && d === 29 && today.month === 2 && today.day === 28 && !isLeapYear(today.year)) {
    return true;
  }
  return false;
}

/** Koliko puni godina danas; null ako godina rođenja nije upisana smisleno. */
export function ageTurning(person, today) {
  const birthYear = Number(person.date.slice(0, 4));
  const age = today.year - birthYear;
  return age > 0 && age < 120 ? age : null;
}

/** Vraća listu onih koji danas slave, uz izračunate godine. */
export async function birthdaysToday() {
  const today = todayInTimezone();
  const all = await notion.listBirthdays();
  return all
    .filter((p) => celebratesOn(p, today))
    .map((p) => ({ ...p, age: ageTurning(p, today) }));
}

/**
 * Nadolazeći rođendani u narednih N dana (za pitanje "ko slavi uskoro").
 */
export async function upcomingBirthdays({ days = 30 } = {}) {
  const today = todayInTimezone();
  const all = await notion.listBirthdays();
  const base = Date.UTC(today.year, today.month - 1, today.day);

  const out = [];
  for (const p of all) {
    const [, m, d] = p.date.slice(0, 10).split('-').map(Number);
    // Probaj ovu godinu; ako je datum prošao, gledaj sledeću.
    let when = Date.UTC(today.year, m - 1, d);
    if (when < base) when = Date.UTC(today.year + 1, m - 1, d);
    const inDays = Math.round((when - base) / 86_400_000);
    if (inDays <= days) {
      out.push({ ...p, inDays, age: ageTurning(p, { year: new Date(when).getUTCFullYear() }) });
    }
  }

  return out.sort((a, b) => a.inDays - b.inDays);
}

/** Da li je danas ponedeljak (u konfigurisanoj vremenskoj zoni). */
export function isMonday() {
  const dan = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    weekday: 'short',
  }).format(new Date());
  return dan === 'Mon';
}

const DANI = ['nedelja', 'ponedeljak', 'utorak', 'sreda', 'četvrtak', 'petak', 'subota'];

/**
 * Rođendani od danas (ponedeljak) do kraja nedelje — 7 dana unapred.
 * Svakom dodaje naziv dana i datum, da se odmah vidi "kad".
 */
export async function birthdaysThisWeek() {
  const people = await upcomingBirthdays({ days: 6 });
  const today = todayInTimezone();
  const base = Date.UTC(today.year, today.month - 1, today.day);

  return people.map((p) => {
    const when = new Date(base + p.inDays * 86_400_000);
    return {
      ...p,
      dayName: DANI[when.getUTCDay()],
      dayDate: `${when.getUTCDate()}.${when.getUTCMonth() + 1}.`,
    };
  });
}

/** Ponedeljkom uz jutarnju poruku — ko slavi ove nedelje i kada. */
export function formatWeekAhead(people) {
  if (people.length === 0) return null;

  const lines = people.map((p) => {
    const kada = p.inDays === 0 ? 'danas' : `${p.dayName} ${p.dayDate}`;
    const godine = p.age ? ` (puni ${p.age})` : '';
    return `• ${kada} — ${p.name}${godine}`;
  });

  const naslov =
    people.length === 1 ? 'Ove nedelje je jedan rođendan:' : `Ove nedelje ima ${people.length} rođendana:`;
  return `🎂 ${naslov}\n${lines.join('\n')}`;
}

// ------------------------------------------------------ praćenje čestitki ---

/** Čita mapu čestitki za današnji dan: { personId: true }. */
function greetedToday() {
  const all = loadState(STATE_NAME, {}) || {};
  return all[todayInTimezone().iso] || {};
}

/**
 * Beleži da je osoba čestitana danas.
 * Usput čisti zapise starije od 7 dana da state ne raste beskonačno.
 */
export function markGreeted(personId) {
  const today = todayInTimezone();
  const all = loadState(STATE_NAME, {}) || {};

  const cutoff = Date.UTC(today.year, today.month - 1, today.day) - 7 * 86_400_000;
  for (const key of Object.keys(all)) {
    const [y, m, d] = key.split('-').map(Number);
    if (Date.UTC(y, m - 1, d) < cutoff) delete all[key];
  }

  all[today.iso] = { ...(all[today.iso] || {}), [personId]: true };
  saveState(STATE_NAME, all);
  logger.info(`Rođendani: označeno da je čestitano (${personId}).`);
}

/**
 * Označava čestitku po imenu — bot ovo zove kad kažeš "čestitao sam Nikoli".
 * Poredi bez razlike u veličini slova i po delu imena, pa je dovoljno "Nikola".
 *
 * @returns {{matched: Array<{id, name}>, ambiguous: boolean, candidates: Array}}
 */
export async function markGreetedByName({ name }) {
  const today = await birthdaysToday();
  if (today.length === 0) {
    return { matched: [], ambiguous: false, candidates: [], reason: 'Danas niko ne slavi.' };
  }

  const needle = String(name).trim().toLowerCase();
  const hits = today.filter((p) => p.name.toLowerCase().includes(needle));

  // Ako ime ne pogađa nikog, a slavi tačno jedna osoba, to je očigledno ona.
  if (hits.length === 0 && today.length === 1) {
    markGreeted(today[0].id);
    return { matched: [{ id: today[0].id, name: today[0].name }], ambiguous: false, candidates: [] };
  }

  if (hits.length === 0) {
    return {
      matched: [],
      ambiguous: false,
      candidates: today.map((p) => p.name),
      reason: `Ne prepoznajem "${name}" među današnjim slavljenicima.`,
    };
  }

  if (hits.length > 1) {
    return { matched: [], ambiguous: true, candidates: hits.map((p) => p.name) };
  }

  markGreeted(hits[0].id);
  return { matched: [{ id: hits[0].id, name: hits[0].name }], ambiguous: false, candidates: [] };
}

/** Današnji slavljenici kojima još nisi čestitao. */
export async function ungreetedToday() {
  const greeted = greetedToday();
  const today = await birthdaysToday();
  return today.filter((p) => !greeted[p.id]);
}

// ------------------------------------------------------------ formatiranje ---

/** Jedan slavljenik u čitljivom obliku (bez Markdown-a — Telegram šalje plain text). */
function personLine(p) {
  const bits = [`🎂 ${p.name}`];
  if (p.age) bits.push(`puni ${p.age}`);
  if (p.relation) bits.push(p.relation.toLowerCase());
  let line = bits.join(' — ');
  if (p.phone) line += `\n   📞 ${p.phone}`;
  if (p.giftIdea) line += `\n   🎁 ideja za poklon: ${p.giftIdea}`;
  if (p.note) line += `\n   📝 ${p.note}`;
  return line;
}

/** Jutarnja poruka u 11:00. */
export function formatMorning(people) {
  if (people.length === 0) return null;
  const header =
    people.length === 1 ? 'Danas je rođendan!' : `Danas slave rođendan (${people.length})!`;
  return `${header}\n\n${people.map(personLine).join('\n\n')}\n\nKad čestitaš, javi mi pa te neću davljati uveče.`;
}

/** Večernji podsetnik u 19:00 — samo za one kojima nisi čestitao. */
export function formatEvening(people) {
  if (people.length === 0) return null;
  const names = people.map((p) => p.name).join(', ');
  return (
    `⏰ Podsetnik: još nisi čestitao rođendan — ${names}.\n\n` +
    `${people.map(personLine).join('\n\n')}\n\n` +
    'Kad čestitaš, reci mi „čestitao sam" pa da zatvorimo priču.'
  );
}
