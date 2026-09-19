import 'dotenv/config';

/**
 * Centralno mesto za sve konfiguracione vrednosti.
 * Čita iz process.env (koje dotenv puni iz .env fajla).
 */

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Nedostaje obavezna promenljiva okruženja: ${name}. ` +
        `Proveri svoj .env fajl (vidi .env.example).`,
    );
  }
  return value;
}

function optional(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Broj iz okruženja, sa zaštitom od nevalidne vrednosti.
 *
 * Bez ovoga `Number('abc')` daje NaN i tiho lomi ponašanje — npr.
 * SITE_MONITOR_TIMEOUT_MS=abc znači `setTimeout(..., NaN)`, što okine odmah,
 * pa bi bot prijavio da su SVI sajtovi pali. Bolje glasno upozorenje i
 * podrazumevana vrednost nego pogrešan podatak.
 */
function numeric(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[config] ${name}="${raw}" nije broj — koristim podrazumevanu vrednost ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Lista iz okruženja, razdvojena zarezima. Prazno = podrazumevana lista.
 * Npr. CHECKLIST_POZITIVNE="Ustajanje 6:00, Vežbanje, Doručak"
 */
function lista(name, fallback) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    ownerChatId: required('TELEGRAM_OWNER_CHAT_ID'),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    // 4096 je znalo da preseče odgovor usred niza poziva alata; presečen
    // odgovor je onda kidao par tool_use/tool_result i rušio ceo razgovor.
    maxTokens: numeric('ANTHROPIC_MAX_TOKENS', 8192),
  },

  notion: {
    apiKey: optional('NOTION_API_KEY'),
    // Baza zadataka (TASK BOARD) — "dodaj mi ovo u taskove".
    tasksDbId: optional('NOTION_TASKS_DB_ID'),
    // Stranica Knowledge Base — "zabeleži ovo u knowledge base".
    kbPageId: optional('NOTION_KB_PAGE_ID'),
    // Baza KLIJENTI — izvor liste sajtova za monitoring (kolone Klijent, Domen, Aktivan).
    clientsDbId: optional('NOTION_CLIENTS_DB_ID'),
    // Baza Rođendani (Dashboard → Life) — podsetnici za čestitanje.
    birthdaysDbId: optional('NOTION_BIRTHDAYS_DB_ID'),
    // Dnevna checklista (Life stranica) — navike po danu.
    checklistDbId: optional('NOTION_CHECKLIST_DB_ID'),
    // Dnevnik (Life stranica) — raspoloženje, energija, ključna reč.
    dnevnikDbId: optional('NOTION_DNEVNIK_DB_ID'),
    // To-do lista (Life stranica) — lični zadaci.
    todoDbId: optional('NOTION_TODO_DB_ID'),
    // Arhiva izdatih faktura — odavde se uzima sledeći redni broj.
    invoicesDbId: optional('NOTION_INVOICES_DB_ID'),
  },

  // Podaci koji idu na svaku fakturu. Menjaju se samo kroz .env — ne kroz chat,
  // da model ne može da izmeni ko je izdavalac ni na koji račun se uplaćuje.
  invoice: {
    issuer: {
      name: optional('INVOICE_ISSUER_NAME', 'Petar Petrović PR Studio Primer'),
      brand: optional('INVOICE_ISSUER_BRAND', 'PRIMER'),
      address: optional('INVOICE_ISSUER_ADDRESS', 'Nikole Tesle 1'),
      city: optional('INVOICE_ISSUER_CITY', 'Beograd'),
      phone: optional('INVOICE_ISSUER_PHONE', '+381600000000'),
      pib: optional('INVOICE_ISSUER_PIB', '100000001'),
      mb: optional('INVOICE_ISSUER_MB', '20000001'),
      bankAccount: optional('INVOICE_ISSUER_ACCOUNT', '000-0000000000000-00'),
      bankName: optional('INVOICE_ISSUER_BANK', 'Naziv banke'),
      responsiblePerson: optional('INVOICE_RESPONSIBLE_PERSON', 'Petar Petrović'),
    },
    comment: optional('INVOICE_COMMENT', 'Račun je važeći bez pečata i potpisa.'),
    vatNote: optional('INVOICE_VAT_NOTE', 'Pravno lice nije u sistemu PDV-a.'),
    // Poslednja faktura izdata PRE ovog bota (format "NNN-GGGG"). Arhiva ne
    // sadrži starije fakture, pa bi numeracija inače krenula od 001.
    // Važi samo za svoju godinu — sledeća godina svejedno kreće od 001.
    lastKnownNumber: optional('INVOICE_LAST_NUMBER'),
    // Folder na Drive-u u koji se snimaju PDF-ovi (prazno = koren Drive-a).
    driveFolderId: optional('GOOGLE_INVOICES_FOLDER_ID'),
    // Putanja do loga koji ide na fakturu. Logo je lični/brendirani fajl pa
    // NIJE u repozitorijumu — najzgodnije ga je staviti u DATA_DIR volumen
    // (npr. /app/data/logo.png). Ako fajla nema, ispisuje se naziv brenda.
    logoPath: optional('INVOICE_LOGO_PATH'),
  },

  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
    redirectUri: optional('GOOGLE_REDIRECT_URI', 'http://localhost:3000/oauth2callback'),
    refreshToken: optional('GOOGLE_REFRESH_TOKEN'),
    calendarId: optional('GOOGLE_CALENDAR_ID', 'primary'),
  },

  mail: {
    imap: {
      host: optional('IMAP_HOST'),
      port: numeric('IMAP_PORT', 993),
      user: optional('IMAP_USER'),
      password: optional('IMAP_PASSWORD'),
    },
    smtp: {
      host: optional('SMTP_HOST'),
      port: numeric('SMTP_PORT', 465),
      secure: optional('SMTP_SECURE', 'true') === 'true',
      user: optional('SMTP_USER'),
      password: optional('SMTP_PASSWORD'),
    },
    from: {
      name: optional('MAIL_FROM_NAME', ''),
      address: optional('MAIL_FROM_ADDRESS', ''),
    },
    // Ako je postavljen, slanje ide preko Resend API-ja umesto SMTP-a.
    resendApiKey: optional('RESEND_API_KEY'),
  },

  // Transkripcija glasovnih poruka (Whisper). Bira se po prisutnom ključu.
  transcription: {
    openaiKey: optional('OPENAI_API_KEY'),
    groqKey: optional('GROQ_API_KEY'),
  },

  // Jutarnja motivaciona poruka. Namerno je piše OpenAI, a ne isti model kao
  // ostatak bota — drugi "glas" i, uz pamćenje prethodnih poruka, manja šansa
  // da se jutra počnu ponavljati. Bez ključa poruku piše Claude.
  motivacija: {
    openaiKey: optional('OPENAI_API_KEY'),
    // gpt-4o-mini podržava temperature/penalty parametre koje kod šalje; ako
    // pređeš na reasoning model (o-serija), proveri da ih ne odbija.
    model: optional('MOTIVATION_MODEL', 'gpt-4o-mini'),
    // Koliko prethodnih poruka ide u prompt kao "ovo ne ponavljaj".
    pamti: numeric('MOTIVATION_HISTORY', 30),
  },

  timezone: optional('TIMEZONE', 'Europe/Belgrade'),

  // Vremenska prognoza (Open-Meteo, bez ključa). Podrazumevano Beograd.
  weather: {
    latitude: numeric('WEATHER_LAT', 44.7866),
    longitude: numeric('WEATHER_LON', 20.4489),
    locationName: optional('WEATHER_LOCATION', 'Beograd'),
  },

  // Prag (%) iznad kojeg bot šalje čestitku u 23:00.
  checklistPraiseThreshold: numeric('CHECKLIST_PRAISE_THRESHOLD', 70),

  // Dnevna checklista navika. Nazivi MORAJU doslovno odgovarati checkbox
  // kolonama u Notion bazi — zato stoje u .env, a ne u kodu: svako ima svoje
  // navike, a i ovako lične stavke ne završe u repozitorijumu.
  checklist: {
    pozitivne: lista('CHECKLIST_POZITIVNE', [
      'Ustajanje 6:00',
      'Vežbanje',
      'Doručak',
      'Vitamini',
      'Večera 19:00',
    ]),
    // Stavke koje počinju sa "Bez " su OBRNUTE — čekirano znači da si uspeo
    // da izbegneš tu stvar.
    izbegavanja: lista('CHECKLIST_IZBEGAVANJA', [
      'Bez slatkog',
      'Bez alkohola',
      'Bez telefona posle 22:00',
    ]),
    // Stavka koja se prati kao nedeljni cilj (npr. odlasci u teretanu).
    ciljnaStavka: optional('CHECKLIST_CILJNA_STAVKA', 'Vežbanje'),
    ciljNedeljno: numeric('CHECKLIST_CILJ_NEDELJNO', 3),
  },

  // Naslov zadatka koji se sam kreira svakog ponedeljka (rok: nedelja).
  nedeljniZadatak: optional('WEEKLY_TASK_TITLE', 'Nedeljni zadatak'),

  // Monitoring sajtova — pragovi za "pao" (timeout) i "sporo".
  monitor: {
    timeoutMs: numeric('SITE_MONITOR_TIMEOUT_MS', 15000),
    slowMs: numeric('SITE_MONITOR_SLOW_MS', 5000),
  },

  cron: {
    // Jutarnji pozdrav (motivacija + prognoza) — svako jutro u 6:00.
    morningGreeting: optional('MORNING_GREETING_CRON', '0 6 * * *'),
    // Poslovni pregled (kalendar, zadaci, mejlovi) — radnim jutrom u 9:30.
    morningBriefing: optional('MORNING_BRIEFING_CRON', '30 9 * * *'),
    taxReminder: optional('TAX_REMINDER_CRON', '0 10 14 * *'),
    // Tiha provera sajtova (javi samo ako ima problema) — svaki dan u 10:00.
    siteCheckSilent: optional('SITE_CHECK_SILENT_CRON', '0 10 * * *'),
    // Pun izveštaj o sajtovima (uvek javi) — svaki dan u 18:00.
    siteCheckReport: optional('SITE_CHECK_REPORT_CRON', '0 18 * * *'),
    // Rođendani: jutarnja najava u 11:00 i večernji podsetnik u 19:00.
    birthdayMorning: optional('BIRTHDAY_MORNING_CRON', '0 11 * * *'),
    birthdayEvening: optional('BIRTHDAY_EVENING_CRON', '0 19 * * *'),
    // Provera nepročitanih mejlova — svaki pun sat od 8 do 22 (ne budi noću).
    mailCheck: optional('MAIL_CHECK_CRON', '0 8-22 * * *'),
    // Kreiranje reda u dnevnoj checklisti — svako jutro u 5:00.
    checklistCreate: optional('CHECKLIST_CREATE_CRON', '0 5 * * *'),
    // Podsetnik da popuniš checklistu — svako veče u 21:30.
    checklistReminder: optional('CHECKLIST_REMINDER_CRON', '30 21 * * *'),
    // Čestitka u 23:00 ako je dan popunjen preko 70%.
    checklistPraise: optional('CHECKLIST_PRAISE_CRON', '0 23 * * *'),
    // Nedeljna pohvala — nedeljom u 22:00.
    weeklySummary: optional('WEEKLY_SUMMARY_CRON', '0 22 * * 0'),
    // Nedeljni zadatak koji se sam obnavlja — ponedeljkom u 5:00.
    flowersTask: optional('FLOWERS_TASK_CRON', '0 5 * * 1'),
    // Osvežavanje indeksa za semantičku pretragu — svaki dan u 4:00 (pre pripreme dana).
    semanticIndex: optional('SEMANTIC_INDEX_CRON', '0 4 * * *'),
  },
};

/**
 * Vraća true ako su sve promenljive za dati servis popunjene.
 * Koristi se da bismo "gasili" alate koji nisu konfigurisani.
 */
export const featureEnabled = {
  // Pretraga radi sa samim ključem; upis traži i konkretan ID odredišta.
  notionSearch: Boolean(config.notion.apiKey),
  notionTasks: Boolean(config.notion.apiKey && config.notion.tasksDbId),
  notionKb: Boolean(config.notion.apiKey && config.notion.kbPageId),
  calendar: Boolean(
    config.google.clientId && config.google.clientSecret && config.google.refreshToken,
  ),
  // Drive deli isti OAuth nalog kao kalendar; traži i Drive scope u tokenu.
  drive: Boolean(
    config.google.clientId && config.google.clientSecret && config.google.refreshToken,
  ),
  mail: Boolean(config.mail.imap.user && config.mail.imap.password),
  voice: Boolean(config.transcription.openaiKey || config.transcription.groqKey),
  // Jutarnju motivaciju piše OpenAI; bez ključa se pada na Claude, pa ovo NE
  // gasi jutarnji pozdrav — samo bira ko ga piše.
  motivacija: Boolean(config.motivacija.openaiKey),
  // Monitoring sajtova traži Notion ključ i ID KLIJENTI baze.
  siteMonitor: Boolean(config.notion.apiKey && config.notion.clientsDbId),
  // Upravljanje bazom klijenata (dodavanje, izmena, pregled).
  notionClients: Boolean(config.notion.apiKey && config.notion.clientsDbId),
  // Podsetnici za rođendane traže Notion ključ i ID baze Rođendani.
  birthdays: Boolean(config.notion.apiKey && config.notion.birthdaysDbId),
  // Fakture traže bazu KLIJENTI (podaci klijenta), bazu FAKTURE (numeracija
  // i arhiva) i Drive (snimanje PDF-a).
  invoices: Boolean(
    config.notion.apiKey &&
      config.notion.clientsDbId &&
      config.notion.invoicesDbId &&
      config.google.clientId &&
      config.google.clientSecret &&
      config.google.refreshToken,
  ),
  // Dnevna checklista traži Notion ključ i ID te baze.
  checklist: Boolean(config.notion.apiKey && config.notion.checklistDbId),
  dnevnik: Boolean(config.notion.apiKey && config.notion.dnevnikDbId),
  todo: Boolean(config.notion.apiKey && config.notion.todoDbId),
  // Trajno pamćenje činjenica — lokalni fajl, bez ikakvog ključa.
  memory: true,
  // Semantička pretraga traži OpenAI ključ (embeddings) i bar jedan izvor.
  semantic: Boolean(
    config.transcription.openaiKey && (config.notion.apiKey || config.google.refreshToken),
  ),
  // Vremenska prognoza (Open-Meteo) ne traži ključ — uvek dostupna.
  weather: true,
  // Generisanje izveštaja u Google Doc traži Drive (isti OAuth kao kalendar).
  reports: Boolean(
    config.google.clientId && config.google.clientSecret && config.google.refreshToken,
  ),
};
