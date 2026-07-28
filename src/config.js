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

export const config = {
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    ownerChatId: required('TELEGRAM_OWNER_CHAT_ID'),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    maxTokens: 4096,
  },

  notion: {
    apiKey: optional('NOTION_API_KEY'),
    // Baza zadataka (TASK BOARD) — "dodaj mi ovo u taskove".
    tasksDbId: optional('NOTION_TASKS_DB_ID'),
    // Stranica Knowledge Base — "zabeleži ovo u knowledge base".
    kbPageId: optional('NOTION_KB_PAGE_ID'),
    // Baza KLIJENTI — izvor liste sajtova za monitoring (kolone Klijent, Domen, Aktivan).
    clientsDbId: optional('NOTION_CLIENTS_DB_ID'),
    // Dnevna checklista (Life stranica) — navike po danu.
    checklistDbId: optional('NOTION_CHECKLIST_DB_ID'),
    // Dnevnik (Life stranica) — raspoloženje, energija, ključna reč.
    dnevnikDbId: optional('NOTION_DNEVNIK_DB_ID'),
    // To-do lista (Life stranica) — lični zadaci.
    todoDbId: optional('NOTION_TODO_DB_ID'),
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
      port: Number(optional('IMAP_PORT', '993')),
      user: optional('IMAP_USER'),
      password: optional('IMAP_PASSWORD'),
    },
    smtp: {
      host: optional('SMTP_HOST'),
      port: Number(optional('SMTP_PORT', '465')),
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

  timezone: optional('TIMEZONE', 'Europe/Belgrade'),

  // Vremenska prognoza (Open-Meteo, bez ključa). Podrazumevano Beograd.
  weather: {
    latitude: Number(optional('WEATHER_LAT', '45.2671')),
    longitude: Number(optional('WEATHER_LON', '19.8335')),
    locationName: optional('WEATHER_LOCATION', 'Novi Sad'),
  },

  // Prag (%) iznad kojeg bot šalje čestitku u 23:00.
  checklistPraiseThreshold: Number(optional('CHECKLIST_PRAISE_THRESHOLD', '70')),

  // Monitoring sajtova — pragovi za "pao" (timeout) i "sporo".
  monitor: {
    timeoutMs: Number(optional('SITE_MONITOR_TIMEOUT_MS', '15000')),
    slowMs: Number(optional('SITE_MONITOR_SLOW_MS', '5000')),
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
    // Nedeljni zadatak "cveće za Sofiju" — ponedeljkom u 5:00.
    flowersTask: optional('FLOWERS_TASK_CRON', '0 5 * * 1'),
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
  // Monitoring sajtova traži Notion ključ i ID KLIJENTI baze.
  siteMonitor: Boolean(config.notion.apiKey && config.notion.clientsDbId),
  // Dnevna checklista traži Notion ključ i ID te baze.
  checklist: Boolean(config.notion.apiKey && config.notion.checklistDbId),
  dnevnik: Boolean(config.notion.apiKey && config.notion.dnevnikDbId),
  todo: Boolean(config.notion.apiKey && config.notion.todoDbId),
  // Vremenska prognoza (Open-Meteo) ne traži ključ — uvek dostupna.
  weather: true,
  // Generisanje izveštaja u Google Doc traži Drive (isti OAuth kao kalendar).
  reports: Boolean(
    config.google.clientId && config.google.clientSecret && config.google.refreshToken,
  ),
};
