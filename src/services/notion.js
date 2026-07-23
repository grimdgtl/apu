import { Client } from '@notionhq/client';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';

/**
 * Notion servis — prilagođen stvarnoj strukturi workspace-a:
 *
 *   TASK BOARD (baza)      → zadaci / to-do lista
 *     kolone: Name (title), Status (Not started | In progress | Done), Assign (person)
 *   📚 Knowledge Base (stranica) → beleške se dodaju kao pod-stranice
 *
 * Plus pretraga po celom workspace-u.
 */

const TASK_STATUSES = ['Not started', 'In progress', 'Done'];

let client = null;
function getClient() {
  if (!config.notion.apiKey) {
    throw new Error('Notion nije konfigurisan (NOTION_API_KEY nedostaje).');
  }
  if (!client) client = new Client({ auth: config.notion.apiKey });
  return client;
}

/** Izvlači čitljiv naslov iz Notion page/database objekta. */
function titleOf(obj) {
  if (obj.object === 'database') {
    return (obj.title || []).map((t) => t.plain_text).join('') || '(bez naslova)';
  }
  const prop = Object.values(obj.properties || {}).find((p) => p.type === 'title');
  return (prop?.title || []).map((t) => t.plain_text).join('') || '(bez naslova)';
}

// ---------------------------------------------------------------- zadaci ---

/**
 * Dodaje zadatak u TASK BOARD.
 */
export async function addTask({ title, status = 'Not started' }) {
  if (!featureEnabled.notionTasks) {
    throw new Error('Baza zadataka nije podešena (NOTION_TASKS_DB_ID nedostaje).');
  }
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`Nepoznat status "${status}". Dozvoljeno: ${TASK_STATUSES.join(', ')}.`);
  }

  const page = await getClient().pages.create({
    parent: { database_id: config.notion.tasksDbId },
    properties: {
      Name: { title: [{ text: { content: title } }] },
      Status: { status: { name: status } },
    },
  });

  logger.info(`Notion: dodat zadatak "${title}" (${status})`);
  return { id: page.id, url: page.url, title, status };
}

/**
 * Čita zadatke iz TASK BOARD-a, opciono filtrirano po statusu.
 */
export async function listTasks({ status, limit = 25 } = {}) {
  if (!featureEnabled.notionTasks) {
    throw new Error('Baza zadataka nije podešena (NOTION_TASKS_DB_ID nedostaje).');
  }

  const res = await getClient().databases.query({
    database_id: config.notion.tasksDbId,
    page_size: limit,
    ...(status ? { filter: { property: 'Status', status: { equals: status } } } : {}),
  });

  const tasks = res.results.map((p) => ({
    id: p.id,
    url: p.url,
    title: titleOf(p),
    status: p.properties?.Status?.status?.name ?? null,
  }));

  logger.debug(`Notion listTasks: ${tasks.length} zadataka`);
  return tasks;
}

/**
 * Menja status postojećeg zadatka (npr. označi kao gotov).
 */
export async function updateTaskStatus({ taskId, status }) {
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`Nepoznat status "${status}". Dozvoljeno: ${TASK_STATUSES.join(', ')}.`);
  }
  const page = await getClient().pages.update({
    page_id: taskId,
    properties: { Status: { status: { name: status } } },
  });
  logger.info(`Notion: zadatak ${taskId} → ${status}`);
  return { id: page.id, url: page.url, status };
}

// -------------------------------------------------------- knowledge base ---

/**
 * Dodaje belešku u Knowledge Base kao novu pod-stranicu.
 * Svaki red teksta postaje zaseban paragraf.
 */
export async function addKnowledge({ title, content = '' }) {
  if (!featureEnabled.notionKb) {
    throw new Error('Knowledge Base nije podešen (NOTION_KB_PAGE_ID nedostaje).');
  }

  const children = String(content)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: line } }] },
    }));

  const page = await getClient().pages.create({
    parent: { page_id: config.notion.kbPageId },
    properties: { title: { title: [{ text: { content: title } }] } },
    children,
  });

  logger.info(`Notion: dodata beleška u Knowledge Base — "${title}"`);
  return { id: page.id, url: page.url, title };
}

// --------------------------------------------------------------- pretraga ---

/**
 * Pretražuje Notion workspace (stranice i baze) po tekstu.
 */
export async function search({ query, limit = 10 }) {
  const res = await getClient().search({ query, page_size: limit });

  const hits = res.results.map((r) => ({
    id: r.id,
    type: r.object,
    title: titleOf(r),
    url: r.url,
    lastEdited: r.last_edited_time,
  }));

  logger.debug(`Notion search "${query}": ${hits.length} rezultata`);
  return hits;
}
