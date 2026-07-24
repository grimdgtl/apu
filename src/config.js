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

  cron: {
    morningBriefing: optional('MORNING_BRIEFING_CRON', '0 10 * * *'),
    taxReminder: optional('TAX_REMINDER_CRON', '0 10 14 * *'),
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
  mail: Boolean(config.mail.imap.user && config.mail.imap.password),
  voice: Boolean(config.transcription.openaiKey || config.transcription.groqKey),
};
