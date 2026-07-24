import { config } from '../config.js';

/**
 * Definicije alata (Anthropic "tools" format) koje Claude može da pozove.
 *
 * Svaka definicija ima i interno polje `feature` — po njemu se alat uključuje
 * ili gasi zavisno od toga šta je konfigurisano. To polje se skida pre slanja
 * modelu (nije deo Anthropic šeme).
 */

const definitions = [
  // ---------- Notion: zadaci ----------
  {
    feature: 'notionTasks',
    name: 'notion_add_task',
    description:
      'Dodaje novi zadatak u to-do listu (Notion baza TASK BOARD). ' +
      'Koristi kada korisnik kaže npr. "dodaj mi ovo u taskove", "podseti me da uradim X", ' +
      '"ubaci na listu".',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Naziv zadatka, kratko i jasno.' },
        status: {
          type: 'string',
          enum: ['Not started', 'In progress', 'Done'],
          description: 'Status zadatka (podrazumevano "Not started").',
        },
      },
      required: ['title'],
    },
  },
  {
    feature: 'notionTasks',
    name: 'notion_list_tasks',
    description:
      'Vraća zadatke iz to-do liste (TASK BOARD). Koristi za "šta imam da radim", ' +
      '"koji su mi otvoreni taskovi", jutarnji pregled i slično.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['Not started', 'In progress', 'Done'],
          description: 'Opciono filtriraj po statusu.',
        },
        limit: { type: 'number', description: 'Maksimalan broj zadataka (default 25).' },
      },
    },
  },
  {
    feature: 'notionTasks',
    name: 'notion_update_task_status',
    description:
      'Menja status postojećeg zadatka — npr. kad korisnik kaže "označi X kao gotovo". ' +
      'Prvo pozovi notion_list_tasks da nađeš ID zadatka.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID zadatka (iz notion_list_tasks).' },
        status: {
          type: 'string',
          enum: ['Not started', 'In progress', 'Done'],
          description: 'Novi status.',
        },
      },
      required: ['taskId', 'status'],
    },
  },

  // ---------- Notion: knowledge base ----------
  {
    feature: 'notionKb',
    name: 'notion_add_knowledge',
    description:
      'Dodaje novu belešku u Knowledge Base (kao pod-stranicu). Koristi kada korisnik kaže ' +
      '"dodaj ovo u knowledge base", "zabeleži ovo", "sačuvaj mi ovaj link/tekst".',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Naslov beleške.' },
        content: {
          type: 'string',
          description: 'Sadržaj beleške. Svaki novi red postaje zaseban pasus.',
        },
      },
      required: ['title'],
    },
  },

  // ---------- Notion: čitanje stranice ----------
  {
    feature: 'notionSearch',
    name: 'notion_read_page',
    description:
      'Čita tekstualni sadržaj Notion stranice. Prvo nađi ID stranice preko ' +
      'notion_search. Koristi npr. kad korisnik traži da se beleška izveze u Drive.',
    input_schema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'ID Notion stranice (iz notion_search).' },
      },
      required: ['pageId'],
    },
  },

  // ---------- Notion: pretraga ----------
  {
    feature: 'notionSearch',
    name: 'notion_search',
    description:
      'Pretražuje ceo Notion workspace (stranice i baze) po tekstu. Koristi kada korisnik ' +
      'traži nešto što je ranije zapisao — "nađi mi ono o...", "gde sam zapisao...".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tekst za pretragu.' },
        limit: { type: 'number', description: 'Maksimalan broj rezultata (default 10).' },
      },
      required: ['query'],
    },
  },

  // ---------- Google Drive ----------
  {
    feature: 'drive',
    name: 'drive_search',
    description:
      'Pretražuje Google Drive po imenu i sadržaju fajla. Koristi za "nađi mi dokument X".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tekst za pretragu.' },
        limit: { type: 'number', description: 'Maksimalan broj rezultata (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    feature: 'drive',
    name: 'drive_read',
    description:
      'Čita sadržaj fajla sa Drive-a kao tekst (Google Docs, Sheets kao CSV, tekstualni ' +
      'fajlovi). Prvo nađi ID preko drive_search. Za slanje sadržaja u Notion, kombinuj sa ' +
      'notion_add_knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'ID fajla (iz drive_search).' },
      },
      required: ['fileId'],
    },
  },
  {
    feature: 'drive',
    name: 'drive_create',
    description:
      'Kreira novi Google Doc sa zadatim tekstom na Drive-u. Koristi npr. za "sačuvaj ovo kao ' +
      'dokument" ili za izvoz Notion beleške (prvo notion_read_page, pa drive_create).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Naziv dokumenta.' },
        content: { type: 'string', description: 'Tekstualni sadržaj dokumenta.' },
      },
      required: ['name', 'content'],
    },
  },

  // ---------- Google Calendar ----------
  {
    feature: 'calendar',
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
    feature: 'calendar',
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
    feature: 'calendar',
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
    feature: 'mail',
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
    feature: 'mail',
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
    feature: 'mail',
    name: 'mail_send',
    description:
      'ŠALJE mejl odmah. Koristi tek nakon što korisnik izričito potvrdi da želi da pošalje. ' +
      'Kada javljaš korisniku ishod, reci jasno da je mejl POSLAT.',
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

  // ---------- Monitoring sajtova ----------
  {
    feature: 'siteMonitor',
    name: 'monitor_check_sites',
    description:
      'Odmah proverava da li su svi aktivni sajtovi klijenata dostupni i dovoljno brzi. ' +
      'Lista sajtova se čita iz Notion KLIJENTI baze (samo status "Aktivan"). Koristi kada ' +
      'korisnik pita "jesu li sajtovi OK", "proveri sajtove", "da li je nešto palo". Vraća ' +
      'status, vreme odgovora i eventualne probleme za svaki sajt.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

export const toolDefinitions = definitions;

/**
 * Vraća alate čiji su servisi konfigurisani, bez internog `feature` polja.
 * @param {Record<string, boolean>} enabled mapa iz config.featureEnabled
 */
export function getEnabledTools(enabled) {
  return definitions
    .filter((t) => enabled[t.feature])
    .map(({ feature, ...tool }) => tool);
}

export const currentTimezone = config.timezone;
