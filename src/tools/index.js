import * as notion from '../services/notion.js';
import * as calendar from '../services/calendar.js';
import * as drive from '../services/drive.js';
import * as mail from '../services/mail.js';
import { checkAllSites } from '../services/monitor.js';
import * as monitorHistory from '../services/monitorHistory.js';
import { getForecast } from '../services/weather.js';
import * as memory from '../services/memory.js';
import * as semantic from '../services/semantic.js';
import * as checklist from '../services/checklist.js';
import * as insights from '../services/insights.js';
import * as dnevnik from '../services/dnevnik.js';
import * as todo from '../services/todo.js';
import { generateReport } from '../services/reports.js';
import * as outbox from '../services/outbox.js';
import { zatraziPotvrduMaila } from '../services/telegram.js';
import {
  birthdaysToday,
  upcomingBirthdays,
  markGreetedByName,
} from '../services/birthdays.js';
import { logger, bezOsetljivog } from '../logger.js';

/**
 * Dispečer alata: mapira ime alata (koje je Claude pozvao) na stvarnu funkciju
 * servisa. Vraća objekat rezultata koji se šalje nazad modelu kao tool_result.
 */

const handlers = {
  // Notion
  notion_add_task: (input) => notion.addTask(input),
  notion_list_tasks: (input) => notion.listTasks(input),
  notion_update_task_status: (input) => notion.updateTaskStatus(input),
  notion_add_knowledge: (input) => notion.addKnowledge(input),
  notion_read_page: (input) => notion.readPage(input),
  notion_search: (input) => notion.search(input),

  // Trajno pamćenje
  memory_save: (input) => memory.zapamti(input),
  memory_list: (input) => memory.lista(input),
  memory_update: (input) => memory.izmeni(input),
  memory_forget: (input) => memory.zaboravi(input),

  // Semantička pretraga
  semantic_search: (input) => semantic.trazi(input),
  semantic_reindex: () => semantic.indeksiraj(),

  // Uptime istorija
  monitor_uptime: (input) => monitorHistory.uptime(input),

  // Uvidi iz navika
  insights_get: (input) => insights.izracunaj(input),

  // Dnevna checklista
  checklist_get: (input) => checklist.stanje(input.datum),
  checklist_mark: (input) => checklist.oznaci(input),
  checklist_create_day: (input) => checklist.kreirajRed(input.datum),

  // Dnevnik
  dnevnik_get: (input) => dnevnik.stanje(input.datum),
  dnevnik_write: (input) => dnevnik.upisi(input),

  // To-do lista (lični zadaci)
  todo_list: (input) => todo.lista(input),
  todo_add: (input) => todo.dodaj(input),
  todo_set_status: (input) => todo.promeniStatus(input),

  // Google Drive
  drive_search: (input) => drive.searchFiles(input),
  drive_read: (input) => drive.readFile(input),
  drive_create: (input) => drive.createDoc(input),

  // Calendar
  calendar_list_events: (input) => calendar.listEvents(input),
  calendar_find_free_slots: (input) => calendar.findFreeSlots(input),
  calendar_create_event: (input) => calendar.createEvent(input),

  // Mail
  mail_list_unread: (input) => mail.listUnread(input),
  mail_save_draft: (input) => mail.saveDraft(input),
  // NE šalje — priprema poruku i traži potvrdu vlasnika dugmetom u Telegramu.
  // Model nema način da sam pošalje mejl, pa ubačeno uputstvo iz tuđeg mejla
  // može najviše da napravi predlog koji korisnik vidi i odbije.
  mail_send: async (input) => {
    if (!input?.to || !input?.subject || !input?.body) {
      throw new Error('Za pripremu mejla trebaju to, subject i body.');
    }
    const id = outbox.pripremi(input);
    await zatraziPotvrduMaila(id, input);
    return {
      poslato: false,
      cekaPotvrdu: true,
      id,
      poruka:
        'Mejl je PRIPREMLJEN i prikazan korisniku sa dugmadima Pošalji/Otkaži. ' +
        'NIJE poslat i ti ga ne možeš poslati — šalje se tek kad korisnik pritisne dugme. ' +
        'Reci korisniku da potvrdi dugmetom; ne tvrdi da je mejl poslat.',
    };
  },

  // Monitoring sajtova
  monitor_check_sites: () => checkAllSites(),

  // Vreme
  weather_get: () => getForecast(),

  // Izveštaji
  generate_report: (input) => generateReport(input),

  // Rođendani
  birthdays_today: () => birthdaysToday(),
  birthdays_upcoming: (input) => upcomingBirthdays(input),
  birthday_mark_greeted: (input) => markGreetedByName(input),
};

/**
 * Izvršava jedan alat. Nikad ne baca — greške vraća kao struktuiran rezultat
 * da bi model mogao da ih objasni korisniku.
 */
export async function executeTool(name, input) {
  const handler = handlers[name];
  if (!handler) {
    return { error: `Nepoznat alat: ${name}` };
  }
  try {
    logger.info(`Alat pozvan: ${name}`, bezOsetljivog(input));
    const result = await handler(input || {});
    return { ok: true, result };
  } catch (err) {
    logger.error(`Greška u alatu ${name}:`, err.message);
    return { ok: false, error: err.message };
  }
}
