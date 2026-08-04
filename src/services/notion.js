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

// ------------------------------------------------------------- čitanje ---

/**
 * Čita tekstualni sadržaj Notion stranice (blokove) kao običan tekst.
 * Koristi se npr. za izvoz beleške u Google Drive.
 */
export async function readPage({ pageId }) {
  const notion = getClient();
  const res = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });

  const lines = [];
  for (const b of res.results) {
    const rich = b[b.type]?.rich_text;
    if (Array.isArray(rich) && rich.length) {
      lines.push(rich.map((r) => r.plain_text).join(''));
    }
  }

  logger.debug(`Notion readPage ${pageId}: ${lines.length} blokova`);
  return { id: pageId, text: lines.join('\n') };
}

// -------------------------------------------------------- klijenti/sajtovi ---

/**
 * Čita aktivne klijente iz KLIJENTI baze i vraća one koji imaju domen.
 *
 * Za monitoring uzimamo samo redove sa `Aktivan` = "Aktivan" (arhiva i sajtovi
 * u izradi se preskaču). Kolone: `Klijent` (title), `Domen` (url), `Aktivan`.
 * Bez URL-a nema šta da se proverava, pa takve redove izostavljamo.
 */
export async function listActiveSites() {
  if (!featureEnabled.siteMonitor) {
    throw new Error('Baza klijenata nije podešena (NOTION_CLIENTS_DB_ID nedostaje).');
  }

  const res = await getClient().databases.query({
    database_id: config.notion.clientsDbId,
    page_size: 100,
    filter: { property: 'Aktivan', select: { equals: 'Aktivan' } },
  });

  const sites = res.results
    .map((p) => ({
      id: p.id,
      name: titleOf(p),
      url: p.properties?.Domen?.url ?? null,
    }))
    .filter((s) => s.url && s.url.trim() !== '');

  logger.debug(`Notion listActiveSites: ${sites.length} aktivnih sajtova`);
  return sites;
}

// -------------------------------------------------------------- klijenti ---

/** Čita rich_text kolonu kao običan tekst. */
function tekstProp(prop) {
  return (prop?.rich_text || []).map((t) => t.plain_text).join('').trim();
}

/**
 * Dozvoljene vrednosti select kolona u KLIJENTI bazi.
 *
 * Notion bi na nepoznatu vrednost tiho napravio NOVU opciju (npr. "aktivan"
 * pored "Aktivan"), pa bi filtriranje po statusu prestalo da hvata sve redove.
 * Zato se proverava unapred i vraća jasna greška.
 */
const KLIJENT_OPCIJE = {
  Aktivan: ['Aktivan', 'Arhiva', 'U izradi'],
  Tip: ['Klijent', 'Interni', 'Veliki ugovor'],
  Status: ['Plaćeno', 'Nije plaćeno', 'Ne plaća'],
  Faktura: ['Poslato', 'Nije poslato', 'Ne plaća'],
  Ponuda: ['Poslato', 'Nije poslato'],
  Trajanje: ['Mesečno', '12 meseci', '6 meseci', 'Nema održavanja'],
  Elementor: ['Da', 'Ne'],
  'Moj hosting': ['Da', 'Ne'],
};

function selectProp(kolona, vrednost) {
  const dozvoljene = KLIJENT_OPCIJE[kolona];
  if (!dozvoljene.includes(vrednost)) {
    throw new Error(
      `Nepoznata vrednost "${vrednost}" za "${kolona}". Dozvoljeno: ${dozvoljene.join(', ')}.`,
    );
  }
  return { select: { name: vrednost } };
}

/** Domen se prima i bez sheme ("illusion.rs"), a upisuje se kao pun URL. */
function urlProp(vrednost) {
  const t = String(vrednost).trim();
  return { url: /^https?:\/\//i.test(t) ? t : `https://${t}` };
}

/**
 * Pretvara ulaz alata u Notion properties objekat.
 * Prazna/izostavljena polja se preskaču — kod izmene znače "ne diraj".
 */
function klijentProperties(u) {
  const p = {};
  const tekst = (v) => ({ rich_text: [{ text: { content: String(v) } }] });

  if (u.naziv) p.Klijent = { title: [{ text: { content: String(u.naziv) } }] };
  if (u.nazivZaFakturu) p['Naziv za fakturu'] = tekst(u.nazivZaFakturu);
  if (u.pib) p.PIB = tekst(u.pib);
  if (u.mb) p.MB = tekst(u.mb);
  if (u.adresa) p.Adresa = tekst(u.adresa);
  if (u.grad) p.Grad = tekst(u.grad);
  if (u.opis) p.Opis = tekst(u.opis);
  if (u.domen) p.Domen = urlProp(u.domen);
  if (u.email) p.Email = { email: String(u.email).trim() };
  if (u.telefon) p.Telefon = { phone_number: String(u.telefon).trim() };
  if (u.odrzavanjeCena !== undefined && u.odrzavanjeCena !== null) {
    p['Održavanje cena'] = { number: Number(u.odrzavanjeCena) };
  }

  for (const [kolona, polje] of [
    ['Aktivan', 'aktivan'],
    ['Tip', 'tip'],
    ['Status', 'status'],
    ['Faktura', 'faktura'],
    ['Ponuda', 'ponuda'],
    ['Trajanje', 'trajanje'],
    ['Elementor', 'elementor'],
    ['Moj hosting', 'mojHosting'],
  ]) {
    if (u[polje]) p[kolona] = selectProp(kolona, u[polje]);
  }

  return p;
}

/** Jedan red KLIJENTI baze u čitljivom obliku. */
function klijentUObjekat(p) {
  const props = p.properties || {};
  const naziv = tekstProp(props['Naziv za fakturu']);
  return {
    id: p.id,
    url: p.url,
    klijent: titleOf(p),
    naziv: naziv || titleOf(p),
    domen: props.Domen?.url ?? null,
    email: props.Email?.email ?? null,
    telefon: props.Telefon?.phone_number ?? null,
    adresa: tekstProp(props.Adresa),
    grad: tekstProp(props.Grad),
    pib: tekstProp(props.PIB),
    mb: tekstProp(props.MB),
    opis: tekstProp(props.Opis),
    aktivan: props.Aktivan?.select?.name ?? null,
    tip: props.Tip?.select?.name ?? null,
    status: props.Status?.select?.name ?? null,
    faktura: props.Faktura?.select?.name ?? null,
    trajanje: props.Trajanje?.select?.name ?? null,
    odrzavanjeCena: props['Održavanje cena']?.number ?? null,
  };
}

function osiguranaBazaKlijenata() {
  if (!config.notion.clientsDbId) {
    throw new Error('Baza klijenata nije podešena (NOTION_CLIENTS_DB_ID nedostaje).');
  }
}

/** Vraća sve redove KLIJENTI baze (paginirano). */
async function sviKlijenti() {
  osiguranaBazaKlijenata();
  const out = [];
  let cursor;
  do {
    const res = await getClient().databases.query({
      database_id: config.notion.clientsDbId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...res.results.map(klijentUObjekat));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return out;
}

/**
 * Dodaje novog klijenta u KLIJENTI bazu.
 *
 * Odbija ako klijent sa istim nazivom već postoji — dupli red bi razbio i
 * izradu faktura (pretraga bi našla dva pogotka) i monitoring.
 */
export async function addClient(ulaz) {
  osiguranaBazaKlijenata();
  if (!ulaz?.naziv) throw new Error('Nedostaje naziv klijenta.');

  const postojeci = await sviKlijenti();
  const isti = postojeci.find(
    (k) => k.klijent.trim().toLowerCase() === String(ulaz.naziv).trim().toLowerCase(),
  );
  if (isti) {
    throw new Error(
      `Klijent "${isti.klijent}" već postoji u bazi. Koristi client_update da dopuniš podatke.`,
    );
  }

  // Podrazumevano nov klijent je aktivan i tipa "Klijent".
  const properties = klijentProperties({ aktivan: 'Aktivan', tip: 'Klijent', ...ulaz });

  const page = await getClient().pages.create({
    parent: { database_id: config.notion.clientsDbId },
    properties,
  });

  logger.info(`Notion: dodat klijent "${ulaz.naziv}".`);
  return { id: page.id, url: page.url, ...klijentUObjekat(page) };
}

/**
 * Menja podatke postojećeg klijenta. Prosleđuju se samo polja koja se menjaju.
 */
export async function updateClient({ klijent, ...izmene }) {
  osiguranaBazaKlijenata();
  if (!klijent) throw new Error('Nedostaje naziv klijenta koji se menja.');

  const pogodci = await findClient({ query: klijent });
  if (pogodci.length === 0) {
    throw new Error(`Ne nalazim klijenta "${klijent}" u bazi.`);
  }
  if (pogodci.length > 1) {
    throw new Error(
      `Naziv "${klijent}" odgovara većem broju klijenata: ${pogodci
        .map((k) => k.klijent)
        .join(', ')}. Budi precizniji.`,
    );
  }

  const properties = klijentProperties(izmene);
  if (Object.keys(properties).length === 0) {
    throw new Error('Nije zadato nijedno polje za izmenu.');
  }

  const page = await getClient().pages.update({ page_id: pogodci[0].id, properties });
  logger.info(`Notion: izmenjen klijent "${pogodci[0].klijent}".`);
  return { id: page.id, url: page.url, ...klijentUObjekat(page) };
}

/** Lista klijenata, opciono filtrirana po statusu (Aktivan/Arhiva/U izradi). */
export async function listClients({ aktivan, limit = 50 } = {}) {
  const svi = await sviKlijenti();
  const filtrirani = aktivan ? svi.filter((k) => k.aktivan === aktivan) : svi;
  logger.debug(`Notion listClients: ${filtrirani.length} klijenata`);
  return filtrirani.slice(0, limit);
}

// --------------------------------------------------------------- fakture ---

/**
 * Nalazi klijenta po delu naziva i vraća njegove fiskalne podatke.
 * Traži i po naslovu (Klijent) i po koloni "Naziv za fakturu".
 */
export async function findClient({ query }) {
  const svi = await sviKlijenti();
  const needle = String(query).trim().toLowerCase();

  // Prvo tačan pogodak — "Illusions" ne sme da bude dvosmisleno samo zato što
  // u bazi postoji i "Illusions World doo".
  const tacan = svi.filter(
    (k) => k.klijent.toLowerCase() === needle || k.naziv.toLowerCase() === needle,
  );
  if (tacan.length > 0) {
    logger.debug(`Notion findClient "${query}": tačan pogodak`);
    return tacan;
  }

  const pogodci = svi.filter(
    (k) => k.klijent.toLowerCase().includes(needle) || k.naziv.toLowerCase().includes(needle),
  );

  logger.debug(`Notion findClient "${query}": ${pogodci.length} pogodaka`);
  return pogodci;
}

/**
 * Sledeći broj fakture za tekuću godinu, u formatu "NNN-GGGG".
 *
 * Broj se izvodi iz same arhive (najveći postojeći za tu godinu + 1) umesto
 * iz lokalnog brojača — tako se ne razilazi sa stvarnim stanjem ako se neka
 * faktura doda ručno ili se izgubi data folder.
 */
export async function nextInvoiceNumber(godina = new Date().getFullYear()) {
  if (!featureEnabled.invoices) {
    throw new Error('Fakture nisu podešene (NOTION_INVOICES_DB_ID ili Google nedostaje).');
  }

  const res = await getClient().databases.query({
    database_id: config.notion.invoicesDbId,
    page_size: 100,
  });

  let najveci = 0;
  for (const p of res.results) {
    const broj = titleOf(p); // "041-2026"
    const m = /^(\d+)\s*-\s*(\d{4})$/.exec(broj.trim());
    if (m && Number(m[2]) === godina) {
      najveci = Math.max(najveci, Number(m[1]));
    }
  }

  const sledeci = String(najveci + 1).padStart(3, '0');
  logger.info(`Notion: sledeći broj fakture za ${godina} je ${sledeci}-${godina}`);
  return `${sledeci}-${godina}`;
}

/** Upisuje izdatu fakturu u arhivu. */
export async function addInvoice({
  broj,
  clientPageId,
  datumIzdavanja,
  datumPrometa,
  iznos,
  stavke,
  mesto,
  pdfUrl,
}) {
  const page = await getClient().pages.create({
    parent: { database_id: config.notion.invoicesDbId },
    properties: {
      Broj: { title: [{ text: { content: broj } }] },
      ...(clientPageId ? { Klijent: { relation: [{ id: clientPageId }] } } : {}),
      'Datum izdavanja': { date: { start: datumIzdavanja } },
      'Datum prometa': { date: { start: datumPrometa } },
      Iznos: { number: Number(iznos) },
      Stavke: { rich_text: [{ text: { content: String(stavke).slice(0, 1900) } }] },
      Status: { select: { name: 'Nije plaćeno' } },
      ...(mesto ? { Mesto: { rich_text: [{ text: { content: mesto } }] } } : {}),
      ...(pdfUrl ? { PDF: { url: pdfUrl } } : {}),
    },
  });

  logger.info(`Notion: faktura ${broj} upisana u arhivu.`);
  return { id: page.id, url: page.url, broj };
}

/** Lista izdatih faktura, najnovije prvo (za "ko mi duguje"). */
export async function listInvoices({ status, limit = 25 } = {}) {
  if (!featureEnabled.invoices) {
    throw new Error('Fakture nisu podešene (NOTION_INVOICES_DB_ID nedostaje).');
  }

  const res = await getClient().databases.query({
    database_id: config.notion.invoicesDbId,
    page_size: limit,
    ...(status ? { filter: { property: 'Status', select: { equals: status } } } : {}),
    sorts: [{ property: 'Datum izdavanja', direction: 'descending' }],
  });

  return res.results.map((p) => ({
    id: p.id,
    url: p.url,
    broj: titleOf(p),
    iznos: p.properties?.Iznos?.number ?? null,
    status: p.properties?.Status?.select?.name ?? null,
    datumIzdavanja: p.properties?.['Datum izdavanja']?.date?.start ?? null,
    stavke: tekstProp(p.properties?.Stavke),
    pdf: p.properties?.PDF?.url ?? null,
  }));
}

// ------------------------------------------------------------- rođendani ---

/**
 * Čita sve unose iz baze Rođendani.
 *
 * Kolone: `Ime i prezime` (title), `Rođendan` (date), `Odnos` (select),
 * `Telefon` (phone), `Ideja za poklon` (text), `Napomena` (text).
 *
 * Ne filtriramo po datumu na Notion strani — Notion ne ume da poredi samo
 * dan i mesec (godina u datumu je godina rođenja), pa poređenje radimo u kodu.
 */
export async function listBirthdays() {
  if (!featureEnabled.birthdays) {
    throw new Error('Baza rođendana nije podešena (NOTION_BIRTHDAYS_DB_ID nedostaje).');
  }

  const people = [];
  let cursor;

  // Baza je mala, ali paginiramo za svaki slučaj.
  do {
    const res = await getClient().databases.query({
      database_id: config.notion.birthdaysDbId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const p of res.results) {
      const props = p.properties || {};
      const date = props['Rođendan']?.date?.start ?? null;
      if (!date) continue; // bez datuma nema podsetnika

      people.push({
        id: p.id,
        url: p.url,
        name: titleOf(p),
        date,
        relation: props['Odnos']?.select?.name ?? null,
        phone: props['Telefon']?.phone_number ?? null,
        giftIdea: (props['Ideja za poklon']?.rich_text || []).map((t) => t.plain_text).join(''),
        note: (props['Napomena']?.rich_text || []).map((t) => t.plain_text).join(''),
      });
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  logger.debug(`Notion listBirthdays: ${people.length} osoba sa datumom`);
  return people;
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
