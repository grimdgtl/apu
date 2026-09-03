import { google } from 'googleapis';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';

/**
 * Google Calendar servis.
 *
 * Autentifikacija ide preko OAuth2 refresh tokena (dobija se jednom kroz
 * `npm run auth:google`). Nakon toga klijent sam osvežava access token.
 */

let calendar = null;

function getCalendar() {
  if (!featureEnabled.calendar) {
    throw new Error(
      'Google Calendar nije konfigurisan (nedostaje CLIENT_ID/SECRET/REFRESH_TOKEN).',
    );
  }
  if (!calendar) {
    const oauth2 = new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      config.google.redirectUri,
    );
    oauth2.setCredentials({ refresh_token: config.google.refreshToken });
    calendar = google.calendar({ version: 'v3', auth: oauth2 });
  }
  return calendar;
}

/**
 * Vraća događaje u zadatom vremenskom opsegu.
 * timeMin/timeMax su ISO stringovi; ako nisu dati, uzima narednih 7 dana.
 */
export async function listEvents({ timeMin, timeMax } = {}) {
  const cal = getCalendar();
  const now = new Date();
  const min = timeMin ? new Date(timeMin) : now;
  const max = timeMax
    ? new Date(timeMax)
    : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const res = await cal.events.list({
    calendarId: config.google.calendarId,
    timeMin: min.toISOString(),
    timeMax: max.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });

  const events = (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || '(bez naslova)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || null,
    attendees: (e.attendees || []).map((a) => a.email),
    htmlLink: e.htmlLink,
  }));

  logger.debug(`Calendar listEvents: ${events.length} događaja`);
  return events;
}

/**
 * Pronalazi slobodne termine (rupe) unutar radnog vremena za zadate dane.
 *
 * @param {object} opts
 * @param {string} opts.timeMin ISO početak opsega
 * @param {string} opts.timeMax ISO kraj opsega
 * @param {number} opts.durationMinutes trajanje traženog termina (default 60)
 * @param {number} opts.workdayStart sat početka radnog dana (default 9)
 * @param {number} opts.workdayEnd sat kraja radnog dana (default 18)
 */
export async function findFreeSlots({
  timeMin,
  timeMax,
  durationMinutes = 60,
  workdayStart = 9,
  workdayEnd = 18,
} = {}) {
  const cal = getCalendar();
  const now = new Date();
  const min = timeMin ? new Date(timeMin) : now;
  const max = timeMax
    ? new Date(timeMax)
    : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const fb = await cal.freebusy.query({
    requestBody: {
      timeMin: min.toISOString(),
      timeMax: max.toISOString(),
      timeZone: config.timezone,
      items: [{ id: config.google.calendarId }],
    },
  });

  const busy = fb.data.calendars[config.google.calendarId].busy.map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));

  const slots = [];
  const durationMs = durationMinutes * 60 * 1000;

  // Idemo dan po dan i tražimo rupe unutar radnog vremena.
  for (
    let day = new Date(min);
    day <= max;
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
  ) {
    const dayStart = new Date(day);
    dayStart.setHours(workdayStart, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(workdayEnd, 0, 0, 0);

    let cursor = new Date(Math.max(dayStart.getTime(), min.getTime(), now.getTime()));

    const dayBusy = busy
      .filter((b) => b.end > dayStart && b.start < dayEnd)
      .sort((a, b) => a.start - b.start);

    for (const b of dayBusy) {
      if (b.start - cursor >= durationMs) {
        slots.push({ start: new Date(cursor), end: new Date(b.start) });
      }
      if (b.end > cursor) cursor = new Date(b.end);
    }
    if (dayEnd - cursor >= durationMs) {
      slots.push({ start: new Date(cursor), end: new Date(dayEnd) });
    }
  }

  const result = slots.map((s) => ({
    start: s.start.toISOString(),
    end: s.end.toISOString(),
  }));
  logger.debug(`Calendar findFreeSlots: ${result.length} slobodnih intervala`);
  return result;
}

const DANI_RRULE = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const UCESTALOSTI = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/**
 * Sastavlja RRULE za ponavljajući događaj.
 *
 * Google čuva ponavljanje kao JEDAN događaj sa pravilom, umesto stotinu
 * pojedinačnih. Bez ovoga bi "svake srede do kraja godine" značilo 21 zaseban
 * poziv alata — što modelu probije ograničenje odgovora i obori ceo zahtev.
 *
 * @param {{ucestalost, dani?, interval?, do?, broj?}} p
 */
function napraviRrule(p) {
  const ucestalost = String(p.ucestalost || 'WEEKLY').toUpperCase();
  if (!UCESTALOSTI.includes(ucestalost)) {
    throw new Error(`Nepoznata učestalost "${p.ucestalost}". Dozvoljeno: ${UCESTALOSTI.join(', ')}.`);
  }

  const delovi = [`FREQ=${ucestalost}`];

  if (p.interval && Number(p.interval) > 1) {
    delovi.push(`INTERVAL=${Number(p.interval)}`);
  }

  if (Array.isArray(p.dani) && p.dani.length) {
    const dani = p.dani.map((d) => String(d).toUpperCase());
    const nepoznat = dani.find((d) => !DANI_RRULE.includes(d));
    if (nepoznat) {
      throw new Error(`Nepoznat dan "${nepoznat}". Dozvoljeno: ${DANI_RRULE.join(', ')}.`);
    }
    delovi.push(`BYDAY=${dani.join(',')}`);
  }

  if (p.do) {
    // UNTIL mora biti UTC vremenska oznaka; uzimamo kraj tog dana.
    const kraj = new Date(`${String(p.do).slice(0, 10)}T23:59:59Z`);
    if (Number.isNaN(kraj.getTime())) {
      throw new Error(`Neispravan datum kraja ponavljanja: "${p.do}".`);
    }
    delovi.push(`UNTIL=${kraj.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  } else if (p.broj && Number(p.broj) > 0) {
    delovi.push(`COUNT=${Number(p.broj)}`);
  }

  return `RRULE:${delovi.join(';')}`;
}

/**
 * Kreira događaj (sastanak), jednokratan ili ponavljajući.
 *
 * @param {object} opts
 * @param {string} opts.summary naslov
 * @param {string} opts.start ISO vreme početka (prvog termina)
 * @param {string} opts.end ISO vreme kraja (prvog termina)
 * @param {string} [opts.location]
 * @param {string} [opts.description]
 * @param {string[]} [opts.attendees] email adrese učesnika
 * @param {object} [opts.ponavljanje] {ucestalost, dani, interval, do, broj}
 */
export async function createEvent({
  summary,
  start,
  end,
  location,
  description,
  attendees = [],
  ponavljanje,
}) {
  const cal = getCalendar();

  const event = {
    summary,
    location,
    description,
    start: { dateTime: new Date(start).toISOString(), timeZone: config.timezone },
    end: { dateTime: new Date(end).toISOString(), timeZone: config.timezone },
    attendees: attendees.map((email) => ({ email })),
    reminders: { useDefault: true },
    ...(ponavljanje ? { recurrence: [napraviRrule(ponavljanje)] } : {}),
  };

  const res = await cal.events.insert({
    calendarId: config.google.calendarId,
    requestBody: event,
    sendUpdates: attendees.length ? 'all' : 'none',
  });

  logger.info(
    `Calendar: kreiran ${ponavljanje ? 'ponavljajući ' : ''}događaj "${summary}" (${res.data.id})`,
  );
  return {
    id: res.data.id,
    summary: res.data.summary,
    start: res.data.start?.dateTime,
    end: res.data.end?.dateTime,
    location: res.data.location || null,
    attendees: (res.data.attendees || []).map((a) => a.email),
    ponavljanje: res.data.recurrence?.[0] ?? null,
    htmlLink: res.data.htmlLink,
  };
}
