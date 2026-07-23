import { config } from '../config.js';

/**
 * Definicije alata (Anthropic "tools" format) koje Claude može da pozove.
 * Svaki alat ima ime, opis (na srpskom, da model dobro razume kada da ga koristi)
 * i JSON schema za ulazne parametre.
 *
 * Trenutno vreme i vremenska zona ubacuju se u system prompt, pa model zna
 * kako da računa "danas", "sutra" itd.
 */

export const toolDefinitions = [
  // ---------- Notion ----------
  {
    name: 'notion_query',
    description:
      'Čita redove iz Notion baze. Koristi za pregled faktura ili stavki održavanja. ' +
      'Vrati listu redova sa svim kolonama.',
    input_schema: {
      type: 'object',
      properties: {
        database: {
          type: 'string',
          enum: ['invoices', 'maintenance'],
          description: 'Koja baza: "invoices" (fakture) ili "maintenance" (održavanje).',
        },
        filterText: {
          type: 'string',
          description: 'Opcioni tekst za filtriranje redova (pretraga po sadržaju).',
        },
        pageSize: {
          type: 'number',
          description: 'Maksimalan broj redova (default 20).',
        },
      },
      required: ['database'],
    },
  },
  {
    name: 'notion_create',
    description:
      'Kreira novi red u Notion bazi (nova faktura ili nova stavka održavanja). ' +
      'Prosledi "fields" kao mapiranje naziva kolone na vrednost, tačno onako kako ' +
      'se kolone zovu u Notion bazi.',
    input_schema: {
      type: 'object',
      properties: {
        database: {
          type: 'string',
          enum: ['invoices', 'maintenance'],
          description: 'Koja baza: "invoices" (fakture) ili "maintenance" (održavanje).',
        },
        fields: {
          type: 'object',
          description:
            'Objekat { "Naziv kolone": vrednost }. Npr. ' +
            '{ "Naziv": "Faktura 001", "Iznos": 15000, "Status": "Neplaćeno" }.',
        },
      },
      required: ['database', 'fields'],
    },
  },

  // ---------- Google Calendar ----------
  {
    name: 'calendar_list_events',
    description:
      'Vraća listu događaja iz kalendara u zadatom vremenskom opsegu. ' +
      'Ako opseg nije zadat, uzima narednih 7 dana.',
    input_schema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'ISO datum/vreme početka opsega.' },
        timeMax: { type: 'string', description: 'ISO datum/vreme kraja opsega.' },
      },
    },
  },
  {
    name: 'calendar_find_free_slots',
    description:
      'Pronalazi slobodne termine (rupe u rasporedu) unutar radnog vremena. ' +
      'Koristi pre zakazivanja da bi predložio termin.',
    input_schema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'ISO početak opsega pretrage.' },
        timeMax: { type: 'string', description: 'ISO kraj opsega pretrage.' },
        durationMinutes: {
          type: 'number',
          description: 'Trajanje traženog termina u minutima (default 60).',
        },
        workdayStart: { type: 'number', description: 'Sat početka radnog dana (0-23, default 9).' },
        workdayEnd: { type: 'number', description: 'Sat kraja radnog dana (0-23, default 18).' },
      },
    },
  },
  {
    name: 'calendar_create_event',
    description:
      'Zakazuje novi sastanak/događaj u kalendaru. Može da doda lokaciju, opis i ' +
      'učesnike (koji dobijaju pozivnicu na email).',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Naslov sastanka.' },
        start: { type: 'string', description: 'ISO vreme početka.' },
        end: { type: 'string', description: 'ISO vreme kraja.' },
        location: { type: 'string', description: 'Lokacija (opciono).' },
        description: { type: 'string', description: 'Opis/napomena (opciono).' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email adrese učesnika (opciono).',
        },
      },
      required: ['summary', 'start', 'end'],
    },
  },

  // ---------- Mail ----------
  {
    name: 'mail_list_unread',
    description: 'Vraća nepročitane mejlove iz sandučeta (najnovije prvo), sa pregledom teksta.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maksimalan broj poruka (default 10).' },
      },
    },
  },
  {
    name: 'mail_save_draft',
    description:
      'Pravi draft (nacrt) odgovora i snima ga u Drafts folder BEZ slanja. ' +
      'Koristi kada korisnik želi da prvo pregleda odgovor.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Email primaoca.' },
        subject: { type: 'string', description: 'Naslov mejla.' },
        body: { type: 'string', description: 'Tekst mejla.' },
        cc: { type: 'string', description: 'CC primaoci (opciono).' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'mail_send',
    description:
      'ŠALJE mejl odmah. Koristi tek nakon što korisnik izričito potvrdi da želi da pošalje.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Email primaoca.' },
        subject: { type: 'string', description: 'Naslov mejla.' },
        body: { type: 'string', description: 'Tekst mejla.' },
        cc: { type: 'string', description: 'CC primaoci (opciono).' },
        inReplyTo: { type: 'string', description: 'Message-ID poruke na koju se odgovara (opciono).' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

/**
 * Vraća samo alate čiji su servisi konfigurisani.
 * `enabled` je mapa: { notion, calendar, mail }.
 */
export function getEnabledTools(enabled) {
  return toolDefinitions.filter((t) => {
    if (t.name.startsWith('notion_')) return enabled.notion;
    if (t.name.startsWith('calendar_')) return enabled.calendar;
    if (t.name.startsWith('mail_')) return enabled.mail;
    return true;
  });
}

export const currentTimezone = config.timezone;
