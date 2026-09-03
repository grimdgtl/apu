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

/** Domen se prima i bez sheme ("primer.rs"), a upisuje se kao pun URL. */
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
    // `naziv` pada na naslov kad kolona nije popunjena; `nazivZaFakturu`
    // ostaje sirov da se vidi da li je kolona zaista prazna.
    naziv: naziv || titleOf(p),
    nazivZaFakturu: naziv,
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

// Pravni oblici i skraćenice koje ne nose identitet firme.
const PRAVNI_OBLICI = new Set([
  'pr', 'doo', 'd', 'o', 'ad', 'dooel', 'preduzetnik', 'agencija',
  'llc', 'ltd', 'inc', 'gmbh', 'company', 'co',
]);

/**
 * Svodi naziv firme na prepoznatljivo jezgro: mala slova, bez dijakritika,
 * bez interpunkcije i bez pravnih oblika.
 *
 * "Petar Pavlović PR ABC STUDIO" → "petar pavlovic abc studio"
 * "ABC Studio"                → "abc studio"
 */
function normalizujNaziv(tekst) {
  return String(tekst ?? '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // skini kvačice sa č, ć, š, ž
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((rec) => rec && !PRAVNI_OBLICI.has(rec))
    .join(' ')
    .trim();
}

/**
 * Da li dva naziva označavaju istu firmu.
 *
 * Isti klijent se u praksi piše na više načina — "ABC Studio" u bazi, a
 * "Petar Pavlović PR ABC STUDIO" na fakturi. Zato je dovoljno da kraći naziv u
 * celosti postoji u dužem. Traži se bar dve značajne reči da "Lab" ne bi
 * pogodio svaku firmu koja tu reč sadrži.
 */
export function istaFirma(a, b) {
  const na = normalizujNaziv(a);
  const nb = normalizujNaziv(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const [manji, veci] = ta.size <= tb.size ? [ta, tb] : [tb, ta];

  if (manji.size < 2) return false;
  return [...manji].every((rec) => veci.has(rec));
}

/**
 * Kandidati za dati naziv, po nivoima strogosti — vraća PRVI nivo koji nešto
 * nađe.
 *
 * Bez stepenovanja bi tačan naziv postao dvosmislen čim u bazi postoji i duži
 * koji ga sadrži: "Slikaj i Cirkaj" bi hvatalo i "Paketi Slikaj i Cirkaj".
 * Ovako tačan pogodak uvek pobeđuje, a šire poređenje se koristi samo kad
 * doslovnog nema.
 */
function kandidatiZaNaziv(svi, naziv) {
  const doslovno = String(naziv).trim().toLowerCase();
  const normalizovan = normalizujNaziv(naziv);

  const nivoi = [
    // 1. Doslovno isti naziv (naslov reda ili naziv za fakturu).
    (k) => k.klijent.toLowerCase() === doslovno || k.naziv.toLowerCase() === doslovno,
    // 2. Isti posle normalizacije — razlika je samo pravni oblik ili pisanje.
    (k) =>
      normalizujNaziv(k.klijent) === normalizovan || normalizujNaziv(k.naziv) === normalizovan,
    // 3. Jedan naziv u celosti sadrži drugi ("Petar Pavlović PR ABC STUDIO" ⊃ "ABC Studio").
    (k) => istaFirma(k.klijent, naziv) || istaFirma(k.naziv, naziv),
  ];

  for (const uslov of nivoi) {
    const pogodci = svi.filter(uslov);
    if (pogodci.length > 0) return pogodci;
  }
  return [];
}

/**
 * Dodaje klijenta — ILI dopunjuje postojećeg ako ga prepozna.
 *
 * Poređenje ne sme da bude doslovno: korisnik jednom pošalje "ABC Studio", a
 * drugi put pun pravni naziv "Petar Pavlović PR ABC STUDIO". Doslovna provera je
 * to propuštala i pravila drugi red za istu firmu, što posle razbija izradu
 * faktura (pretraga nađe dva pogotka pa odbije da nastavi).
 *
 * Kad nađe tačno jedan pogodak, podaci se upisuju U TAJ red. Kad ih nađe
 * više, ne pogađa — traži da korisnik precizira.
 */
export async function addClient(ulaz) {
  osiguranaBazaKlijenata();
  if (!ulaz?.naziv) throw new Error('Nedostaje naziv klijenta.');

  const postojeci = await sviKlijenti();
  const kandidati = kandidatiZaNaziv(postojeci, ulaz.naziv);

  if (kandidati.length > 1) {
    throw new Error(
      `"${ulaz.naziv}" liči na više klijenata u bazi: ${kandidati
        .map((k) => k.klijent)
        .join(', ')}. Preciziraj o kome se radi i koristi client_update.`,
    );
  }

  if (kandidati.length === 1) {
    const p = kandidati[0];

    // Naslov reda se NE menja — korisnik ga je tako nazvao. Ako je poslao
    // duži, pravni naziv a kolona za fakturu je prazna, tu mu je mesto.
    const izmene = { ...ulaz };
    delete izmene.naziv;
    if (
      !izmene.nazivZaFakturu &&
      !p.nazivZaFakturu &&
      String(ulaz.naziv).trim() !== p.klijent.trim()
    ) {
      izmene.nazivZaFakturu = ulaz.naziv;
    }

    const properties = klijentProperties(izmene);
    if (Object.keys(properties).length === 0) {
      return { ...p, dopunjen: false, poruka: `Klijent "${p.klijent}" već postoji; nema šta da se dopuni.` };
    }

    const page = await getClient().pages.update({ page_id: p.id, properties });
    logger.info(`Notion: dopunjen postojeći klijent "${p.klijent}" (nije napravljen nov red).`);
    return {
      id: page.id,
      url: page.url,
      ...klijentUObjekat(page),
      dopunjen: true,
      poruka:
        `Klijent "${p.klijent}" već postoji u bazi, pa su podaci upisani u TAJ red — ` +
        'nije napravljen novi. Reci to korisniku.',
    };
  }

  // Podrazumevano nov klijent je aktivan i tipa "Klijent".
  const properties = klijentProperties({ aktivan: 'Aktivan', tip: 'Klijent', ...ulaz });

  const page = await getClient().pages.create({
    parent: { database_id: config.notion.clientsDbId },
    properties,
  });

  logger.info(`Notion: dodat nov klijent "${ulaz.naziv}".`);
  return { id: page.id, url: page.url, ...klijentUObjekat(page), dopunjen: false };
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

  const kandidati = kandidatiZaNaziv(svi, query);
  if (kandidati.length > 0) {
    logger.debug(`Notion findClient "${query}": ${kandidati.length} pogodaka`);
    return kandidati;
  }

  // Poslednji pokušaj — deo naziva, za slučaj da korisnik napiše samo "Illus".
  const needle = String(query).trim().toLowerCase();
  const delimicni = svi.filter(
    (k) => k.klijent.toLowerCase().includes(needle) || k.naziv.toLowerCase().includes(needle),
  );

  logger.debug(`Notion findClient "${query}": ${delimicni.length} delimičnih pogodaka`);
  return delimicni;
}

/** Rastavlja "007-2026" na {redni: 7, godina: 2026}; null ako format ne valja. */
function razloziBroj(tekst) {
  const m = /^(\d+)\s*-\s*(\d{4})$/.exec(String(tekst).trim());
  return m ? { redni: Number(m[1]), godina: Number(m[2]) } : null;
}

/**
 * Sledeći broj fakture za zadatu godinu, u formatu "NNN-GGGG".
 *
 * Broj se izvodi iz same arhive (najveći postojeći za tu godinu + 1) umesto
 * iz lokalnog brojača — tako se ne razilazi sa stvarnim stanjem ako se neka
 * faktura doda ručno ili se izgubi data folder.
 *
 * Fakture izdate PRE ovog bota nisu u arhivi, pa bi prva krenula od 001 i
 * ponovila već izdat broj. Zato se poslednji ručno izdat broj zadaje kroz
 * INVOICE_LAST_NUMBER. Taj prag važi ISKLJUČIVO za svoju godinu — kad dođe
 * nova godina, brojanje samo krene od 001, bez ikakve izmene podešavanja.
 */
export async function nextInvoiceNumber(godina = new Date().getFullYear()) {
  if (!featureEnabled.invoices) {
    throw new Error('Fakture nisu podešene (NOTION_INVOICES_DB_ID ili Google nedostaje).');
  }

  let najveci = 0;

  const prag = razloziBroj(config.invoice.lastKnownNumber ?? '');
  if (config.invoice.lastKnownNumber && !prag) {
    logger.warn(
      `INVOICE_LAST_NUMBER="${config.invoice.lastKnownNumber}" nije u formatu NNN-GGGG — ignorišem.`,
    );
  }
  if (prag && prag.godina === godina) {
    najveci = prag.redni;
  }

  // Arhiva je merodavna ako je odmakla dalje od praga.
  let cursor;
  do {
    const res = await getClient().databases.query({
      database_id: config.notion.invoicesDbId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const p of res.results) {
      const broj = razloziBroj(titleOf(p));
      if (broj && broj.godina === godina) {
        najveci = Math.max(najveci, broj.redni);
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

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
