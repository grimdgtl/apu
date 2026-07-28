import * as notion from '../services/notion.js';
import * as calendar from '../services/calendar.js';
import * as drive from '../services/drive.js';
import * as mail from '../services/mail.js';
import { checkAllSites } from '../services/monitor.js';
import { getForecast } from '../services/weather.js';
import * as checklist from '../services/checklist.js';
import * as dnevnik from '../services/dnevnik.js';
import * as todo from '../services/todo.js';
import { generateReport } from '../services/reports.js';
import { logger } from '../logger.js';

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
  mail_send: (input) => mail.sendMail(input),

  // Monitoring sajtova
  monitor_check_sites: () => checkAllSites(),

  // Vreme
  weather_get: () => getForecast(),

  // Izveštaji
  generate_report: (input) => generateReport(input),
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
    logger.info(`Alat pozvan: ${name}`, JSON.stringify(input));
    const result = await handler(input || {});
    return { ok: true, result };
  } catch (err) {
    logger.error(`Greška u alatu ${name}:`, err.message);
    return { ok: false, error: err.message };
  }
}
