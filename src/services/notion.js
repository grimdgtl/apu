import { Client } from '@notionhq/client';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';

/**
 * Notion servis.
 *
 * Radi sa dve baze:
 *   - fakture     (config.notion.invoicesDbId)
 *   - održavanje  (config.notion.maintenanceDbId)
 *
 * Napomena: nazivi property-ja (kolona) u Notion bazama moraju da postoje.
 * Kod je pisan fleksibilno — čita sve property-je kakvi god da su, a pri
 * upisu pokušava da mapira na najčešće nazive. Prilagodi `buildProperties`
 * svojoj šemi ako se kolone drugačije zovu.
 */

let client = null;
function getClient() {
  if (!featureEnabled.notion) {
    throw new Error('Notion nije konfigurisan (NOTION_API_KEY nedostaje).');
  }
  if (!client) client = new Client({ auth: config.notion.apiKey });
  return client;
}

function resolveDbId(database) {
  if (database === 'invoices') return config.notion.invoicesDbId;
  if (database === 'maintenance') return config.notion.maintenanceDbId;
  throw new Error(`Nepoznata baza: ${database}. Koristi "invoices" ili "maintenance".`);
}

/**
 * Pretvara Notion property objekat u običnu vrednost (string/number/...).
 */
function readProperty(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':
      return prop.title.map((t) => t.plain_text).join('');
    case 'rich_text':
      return prop.rich_text.map((t) => t.plain_text).join('');
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name ?? null;
    case 'multi_select':
      return prop.multi_select.map((s) => s.name);
    case 'status':
      return prop.status?.name ?? null;
    case 'date':
      return prop.date?.start ?? null;
    case 'checkbox':
      return prop.checkbox;
    case 'url':
      return prop.url;
    case 'email':
      return prop.email;
    case 'phone_number':
      return prop.phone_number;
    case 'people':
      return prop.people.map((p) => p.name ?? p.id);
    default:
      return null;
  }
}

function pageToObject(page) {
  const out = { id: page.id, url: page.url };
  for (const [key, value] of Object.entries(page.properties)) {
    out[key] = readProperty(value);
  }
  return out;
}

/**
 * Čita redove iz baze. Opcioni `filterText` radi prostu pretragu po naslovu.
 */
export async function queryDatabase(database, { pageSize = 20, filterText } = {}) {
  const notion = getClient();
  const database_id = resolveDbId(database);
  if (!database_id) throw new Error(`ID baze "${database}" nije podešen u .env.`);

  const query = { database_id, page_size: pageSize };

  const response = await notion.databases.query(query);
  let rows = response.results.map(pageToObject);

  if (filterText) {
    const needle = filterText.toLowerCase();
    rows = rows.filter((r) =>
      Object.values(r).some(
        (v) => typeof v === 'string' && v.toLowerCase().includes(needle),
      ),
    );
  }

  logger.debug(`Notion query ${database}: ${rows.length} redova`);
  return rows;
}

/**
 * Gradi Notion "properties" objekat iz jednostavnog { kolona: vrednost } mapiranja.
 * Prvo dohvata šemu baze da bi znao tip svake kolone.
 */
async function buildProperties(database_id, fields) {
  const notion = getClient();
  const db = await notion.databases.retrieve({ database_id });
  const schema = db.properties;
  const properties = {};

  for (const [name, value] of Object.entries(fields)) {
    const colDef = schema[name];
    if (!colDef) {
      logger.warn(`Notion: kolona "${name}" ne postoji u bazi — preskačem.`);
      continue;
    }
    switch (colDef.type) {
      case 'title':
        properties[name] = { title: [{ text: { content: String(value) } }] };
        break;
      case 'rich_text':
        properties[name] = { rich_text: [{ text: { content: String(value) } }] };
        break;
      case 'number':
        properties[name] = { number: Number(value) };
        break;
      case 'select':
        properties[name] = { select: { name: String(value) } };
        break;
      case 'status':
        properties[name] = { status: { name: String(value) } };
        break;
      case 'multi_select':
        properties[name] = {
          multi_select: (Array.isArray(value) ? value : [value]).map((v) => ({
            name: String(v),
          })),
        };
        break;
      case 'date':
        properties[name] = { date: { start: String(value) } };
        break;
      case 'checkbox':
        properties[name] = { checkbox: Boolean(value) };
        break;
      case 'url':
        properties[name] = { url: String(value) };
        break;
      case 'email':
        properties[name] = { email: String(value) };
        break;
      default:
        logger.warn(`Notion: nepodržan tip kolone "${name}" (${colDef.type}).`);
    }
  }
  return properties;
}

/**
 * Kreira novi red (page) u zadatoj bazi.
 */
export async function createRow(database, fields) {
  const notion = getClient();
  const database_id = resolveDbId(database);
  if (!database_id) throw new Error(`ID baze "${database}" nije podešen u .env.`);

  const properties = await buildProperties(database_id, fields);
  const page = await notion.pages.create({
    parent: { database_id },
    properties,
  });
  logger.info(`Notion: kreiran red u "${database}" (${page.id})`);
  return pageToObject(page);
}
