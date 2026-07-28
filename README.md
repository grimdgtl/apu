# APU — personal Telegram AI assistant

A Telegram bot powered by Claude that uses **tool calling** to manage your Notion,
Google Calendar, Google Drive and email, monitor client website uptime, track daily
habits, and send proactive reminders.

You talk to it in plain language — by **text**, **voice message** or **photo** — and it
decides which tools to call and performs the action. It replies in Serbian.

```
Text / Voice / Image  →  Telegram  →  Claude (agentic loop)  →  tools  →  reply
                                                                ├─ Notion (tasks, notes, habits, journal)
                                                                ├─ Google Calendar
                                                                ├─ Google Drive
                                                                ├─ Email (IMAP + Resend)
                                                                ├─ Weather
                                                                └─ Website monitoring
```

---

## Contents

- [Features](#features)
- [Project structure](#project-structure)
- [Installation](#installation)
- [Integration setup](#integration-setup)
- [Environment variables](#environment-variables)
- [Running](#running)
- [Deployment (Coolify)](#deployment-coolify)
- [Commands and examples](#commands-and-examples)
- [Proactive reminders](#proactive-reminders)
- [Troubleshooting](#troubleshooting)
- [Notes](#notes)

---

## Features

### Input types

| Type | Behaviour |
|---|---|
| **Text** | Regular message. |
| **Voice** | Transcribed with Whisper, then handled exactly like text. The bot **replies in text**, never with audio. |
| **Image** | Sent to Claude for analysis (e.g. "extract the total from this receipt"). Supported: JPEG, PNG, GIF, WebP — as a photo or as a file. |

### Tools available to Claude

| Area | Tools |
|---|---|
| **Notion — work tasks** | `notion_add_task`, `notion_list_tasks`, `notion_update_task_status` |
| **Notion — knowledge base** | `notion_add_knowledge` |
| **Notion — reading** | `notion_search`, `notion_read_page` |
| **Daily habit checklist** | `checklist_get`, `checklist_mark`, `checklist_create_day` |
| **Journal** | `dnevnik_get`, `dnevnik_write` |
| **Personal to-do list** | `todo_list`, `todo_add`, `todo_set_status` |
| **Google Drive** | `drive_search`, `drive_read`, `drive_create` |
| **Google Calendar** | `calendar_list_events`, `calendar_find_free_slots`, `calendar_create_event` |
| **Email** | `mail_list_unread`, `mail_save_draft`, `mail_send` |
| **Weather** | `weather_get` |
| **Website monitoring** | `monitor_check_sites` |
| **Reports** | `generate_report` (writes a report into a Google Doc) |

Tools whose services are not configured are **switched off automatically** — the model
never sees them. Check the current state with the `/status` command.

---

## Project structure

```
apu/
├── Dockerfile              # optional build (see Deployment)
├── .env.example            # every environment variable
├── scripts/
│   └── google-auth.js      # one-off Google refresh-token helper
└── src/
    ├── index.js            # entry point: starts the bot + scheduler
    ├── config.js           # configuration + featureEnabled (which tools are active)
    ├── logger.js
    ├── store.js            # persists conversation history and small state to disk
    ├── services/
    │   ├── telegram.js     # Telegraf: text/voice/photo handlers, commands
    │   ├── claude.js       # Anthropic client + agentic loop + system prompt
    │   ├── notion.js       # work tasks, knowledge base, search, page reading
    │   ├── checklist.js    # daily habit checklist (+ weekly gym goal)
    │   ├── dnevnik.js      # journal: mood, energy, keyword
    │   ├── todo.js         # personal to-do list (+ weekly recurring task)
    │   ├── calendar.js     # agenda, free slots, scheduling
    │   ├── drive.js        # search, read, create documents
    │   ├── mail.js         # IMAP read/drafts + sending (Resend or SMTP)
    │   ├── transcribe.js   # Whisper (OpenAI or Groq)
    │   ├── weather.js      # Open-Meteo forecast
    │   ├── monitor.js      # client website uptime checks
    │   ├── reports.js      # report generation into a Google Doc
    │   └── scheduler.js    # cron reminders
    └── tools/
        ├── definitions.js  # tool definitions (Anthropic format) + feature gating
        └── index.js        # dispatcher: tool name → service function
```

---

## Installation

Requires **Node.js ≥ 18.17** (22+ recommended).

```bash
git clone https://github.com/grimdgtl/apu.git
cd apu
npm install
cp .env.example .env
```

Fill in `.env` (see below), then run `npm start`.

---

## Integration setup

### 1. Telegram
1. [@BotFather](https://t.me/BotFather) → `/newbot` → gives you **`TELEGRAM_BOT_TOKEN`**.
2. [@userinfobot](https://t.me/userinfobot) → your chat ID → **`TELEGRAM_OWNER_CHAT_ID`**.

> The bot replies **only to its owner** — messages from anyone else are ignored.

### 2. Anthropic (Claude)
Get a key at <https://console.anthropic.com> → **`ANTHROPIC_API_KEY`**.
Pick the model with `ANTHROPIC_MODEL` (defaults to `claude-sonnet-5`; use
`claude-opus-4-8` for maximum capability).

### 3. Notion
1. Create an **internal integration**: <https://www.notion.so/my-integrations> →
   **`NOTION_API_KEY`**.
   - The integration must live in the **same workspace** as your pages.
   - Capabilities: **Read**, **Update**, **Insert** content.
2. Grant it access: *integration → **Content access** → add the parent page*
   (access is inherited by everything below it).
3. Copy the 32-character IDs from the database URLs:

| Variable | Database / page | Expected columns |
|---|---|---|
| `NOTION_TASKS_DB_ID` | Work task board | `Name`, `Status`, `Assign` |
| `NOTION_KB_PAGE_ID` | Knowledge Base page | — (notes are added as sub-pages) |
| `NOTION_CLIENTS_DB_ID` | Clients database | `Klijent` (title), `Domen` (URL), `Aktivan` (select) |
| `NOTION_CHECKLIST_DB_ID` | Daily habit checklist | `Dan` (title), `Datum` (date), 15 checkboxes |
| `NOTION_DNEVNIK_DB_ID` | Journal | `Dan`, `Datum`, `Raspoloženje`, `Energija`, `Ključna reč` |
| `NOTION_TODO_DB_ID` | Personal to-do list | `Zadatak`, `Status`, `Oblast`, `Prioritet`, `Rok` |

> **Checklist semantics.** Items starting with `Bez ` ("without") are **inverted**:
> ticking them means you successfully avoided that thing. "I didn't drink Coke" sets
> `Bez Coca-Cole` to true. The tool description teaches the model this explicitly.

### 4. Google (Calendar + Drive)
1. [Google Cloud Console](https://console.cloud.google.com) → OAuth 2.0 **Desktop**
   credentials → **`GOOGLE_CLIENT_ID`**, **`GOOGLE_CLIENT_SECRET`**.
2. Enable **both** APIs: *Google Calendar API* and *Google Drive API*.
3. **OAuth consent screen → Publish app (Production)** — in "Testing" mode the refresh
   token expires after 7 days.
4. Run once:
   ```bash
   npm run auth:google
   ```
   Open the printed URL, approve access (it requests Calendar + Drive), then paste the
   printed **`GOOGLE_REFRESH_TOKEN`** into `.env`.

### 5. Email
- **Reading (IMAP):** `IMAP_HOST/PORT/USER/PASSWORD` — on cPanel this is usually
  `mail.yourdomain.com:993`, with the full address as the username.
- **Sending:** two options —
  - **Resend (recommended):** create an account at [resend.com](https://resend.com),
    verify your domain (DNS records), then set **`RESEND_API_KEY`**. It goes over HTTPS,
    so it works even when SMTP ports are blocked.
  - **SMTP:** `SMTP_HOST/PORT/SECURE/USER/PASSWORD`. Used **only when `RESEND_API_KEY`
    is not set**.

> Many hosting providers (Hetzner among them) block outbound SMTP ports — see
> [Troubleshooting](#troubleshooting).

### 6. Voice messages
Set **one** key:
- **`OPENAI_API_KEY`** → `whisper-1`
- **`GROQ_API_KEY`** → `whisper-large-v3` (has a free tier)

### 7. Weather
No key required (Open-Meteo). Set the location with `WEATHER_LOCATION`, `WEATHER_LAT`,
`WEATHER_LON`.

---

## Environment variables

| Variable | Required | Default | Description |
|---|:---:|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Token from @BotFather |
| `TELEGRAM_OWNER_CHAT_ID` | Yes | — | Your chat ID (whitelist) |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `ANTHROPIC_MODEL` | | `claude-sonnet-5` | Model |
| `NOTION_API_KEY` | | — | Internal Notion integration token |
| `NOTION_TASKS_DB_ID` | | — | Work task board |
| `NOTION_KB_PAGE_ID` | | — | Knowledge Base page |
| `NOTION_CLIENTS_DB_ID` | | — | Clients database (website monitoring) |
| `NOTION_CHECKLIST_DB_ID` | | — | Daily habit checklist |
| `NOTION_DNEVNIK_DB_ID` | | — | Journal |
| `NOTION_TODO_DB_ID` | | — | Personal to-do list |
| `GOOGLE_CLIENT_ID` | | — | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | | — | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | | `http://localhost:3000/oauth2callback` | Used by the auth script only |
| `GOOGLE_REFRESH_TOKEN` | | — | From `npm run auth:google` (Calendar + Drive) |
| `GOOGLE_CALENDAR_ID` | | `primary` | Which calendar to use |
| `IMAP_HOST` / `IMAP_PORT` | | — / `993` | Reading mail |
| `IMAP_USER` / `IMAP_PASSWORD` | | — | Full address + password |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | | — / `465` / `true` | Sending (fallback) |
| `SMTP_USER` / `SMTP_PASSWORD` | | — | Credentials |
| `MAIL_FROM_NAME` / `MAIL_FROM_ADDRESS` | | — | Displayed sender |
| `RESEND_API_KEY` | | — | If set → sending goes through Resend |
| `OPENAI_API_KEY` | | — | Whisper transcription |
| `GROQ_API_KEY` | | — | Whisper alternative |
| `TIMEZONE` | | `Europe/Belgrade` | Timezone for cron jobs and events |
| `WEATHER_LOCATION` | | `Novi Sad` | City name shown in messages |
| `WEATHER_LAT` / `WEATHER_LON` | | `45.2671` / `19.8335` | Coordinates |
| `SITE_MONITOR_TIMEOUT_MS` | | `15000` | Threshold for "site down" |
| `SITE_MONITOR_SLOW_MS` | | `5000` | Threshold for "slow" |
| `MORNING_GREETING_CRON` | | `0 6 * * *` | Morning greeting + weather |
| `MORNING_BRIEFING_CRON` | | `30 9 * * *` | Work briefing |
| `TAX_REMINDER_CRON` | | `0 10 14 * *` | Tax reminder |
| `SITE_CHECK_SILENT_CRON` | | `0 10 * * *` | Silent website check |
| `SITE_CHECK_REPORT_CRON` | | `0 18 * * *` | Full website report |
| `MAIL_CHECK_CRON` | | `0 8-22 * * *` | Unread-mail check |
| `CHECKLIST_CREATE_CRON` | | `0 5 * * *` | Creates the day's checklist row |
| `CHECKLIST_REMINDER_CRON` | | `30 21 * * *` | Evening checklist reminder |
| `CHECKLIST_PRAISE_CRON` | | `0 23 * * *` | Congratulation for a good day |
| `CHECKLIST_PRAISE_THRESHOLD` | | `70` | Threshold (%) for the congratulation |
| `WEEKLY_SUMMARY_CRON` | | `0 22 * * 0` | Weekly praise (Sunday) |
| `FLOWERS_TASK_CRON` | | `0 5 * * 1` | Weekly recurring personal task |
| `DATA_DIR` | | `./data` | Where conversation history is stored |
| `NIXPACKS_NODE_VERSION` | | — | Build-time only (Coolify/Nixpacks) — set to `22` |

> **`TIMEZONE` is not the weather location.** `TIMEZONE` controls cron scheduling and
> date handling; the forecast city is configured through the `WEATHER_*` variables.

> `NIXPACKS_NODE_VERSION` is **not read by the application** — it is consumed by Coolify
> during the build. It lives in `.env.example` so it gets copied over with everything else.

---

## Running

```bash
npm start        # production
npm run dev      # auto-reload (node --watch)
```

The bot uses **long polling** — no public server, domain or webhook required.

On startup it logs which integrations are active (the list is derived from the
configuration itself, so nothing can silently drop out of it):

```
Active integrations: {
  notionPretraga: true, notionZadaci: true, notionKb: true,
  calendar: true, drive: true, mail: true, glasovne: true,
  monitoringSajtova: true, checklista: true, dnevnik: true,
  todoLista: true, prognoza: true, izvestaji: true
}
```

Anything that is switched off is additionally printed as a warning.

---

## Deployment (Coolify)

The bot is a **background worker** — it does not listen on any HTTP port.

1. **New Resource → Application**, source GitHub → repo, branch `main`.
2. **Build Pack: Nixpacks** (default). Make sure to add **`NIXPACKS_NODE_VERSION=22`** —
   without it Nixpacks builds with Node 18, which is EOL.
3. **No domain, no port.** Leave Ports/Domains empty and **disable the Health Check**
   (there is no HTTP endpoint; an enabled health check restarts the container in a loop).
4. **Storages → Volume Mount** → *Name:* `apu-data`, *Destination Path:* `/app/data`,
   **Source Path empty**.
   > Without a volume the bot **forgets conversation history** on every redeploy.
   > The working directory is `/app`, so the default `DATA_DIR=./data` resolves to
   > `/app/data` — you may leave the variable out entirely.
5. **Environment Variables** — copy everything from `.env` (that file is not in git).
6. **Deploy.**

> **Alternative — Dockerfile.** The repo contains a `Dockerfile` (Node 22, explicit
> `DATA_DIR`, runs as a non-root user). If you switch to **Build Pack: Dockerfile**, note
> that an existing volume may be owned by `root` (because the Nixpacks build ran as root),
> so the non-root process will fail to write to it with `EACCES`. In that case either
> change the volume ownership or drop `USER node` from the Dockerfile.

> Opening the auto-generated `sslip.io` URL returns **Bad Gateway** — that is expected,
> the bot has no web interface. Check status through Logs and through Telegram.

---

## Commands and examples

| Command | Effect |
|---|---|
| `/start` | Greeting |
| `/status` | Shows which integrations are enabled |
| `/reset` | Clears conversation history |

Everything else is plain language (the bot is used in Serbian):

```
"Šta imam sutra u kalendaru?"                  → tomorrow's agenda
"Zakaži sastanak sa Markom u utorak u 14h."    → schedules an event
"Nađi slobodan termin od sat vremena."         → finds a free slot
"Pročitaj mi nepročitane mejlove."             → lists unread mail
"Odgovori mu da mi termin odgovara."           → drafts, asks before sending
"Šta imam da radim?"                           → work tasks
"Dodaj mi u taskove: platiti porez do 14."
"Označi 'Eko taksa' kao gotovo."
"Dodaj u knowledge base: Printful — dropshipping."
"Nađi mi na Drive-u pripremu za epizodu."
"Sačuvaj taj dokument u Notion knowledge base." → Drive → Notion bridge
"Popio sam kreatin i bio u teretani."           → ticks checklist items
"Nisam pio kokakolu ni pušio."                  → ticks the "Bez ..." items
"Šta mi fali danas na checklisti?"
"Koliko sam puta ove nedelje bio u teretani?"
"Danas sam se osećao dobro, bio sam fokusiran." → writes the journal, asks for the rest
"Kakvo je vreme?"
"Proveri da li rade sajtovi klijenata."
```

---

## Proactive reminders

| When | What |
|---|---|
| Every day **5:00** | Creates the day's checklist row and journal entry (linked to each other), silently |
| Monday **5:00** | Creates the weekly recurring personal task (due Sunday) |
| Every day **6:00** | Morning greeting: motivation + weather forecast |
| Every day **9:30** | Work briefing: calendar, tasks, unread mail (no weather) |
| **Hourly, 8–22** | Unread-mail check — reports **only new** messages |
| Every day **10:00** | Silent website check — speaks up **only if something is wrong** |
| Every day **18:00** | Full website uptime report |
| Every day **21:30** | Reminder to fill in the checklist + gym progress, journal and open weekly task |
| Every day **23:00** | Congratulation if the checklist is over 70% complete (otherwise silent) |
| Sunday **22:00** | Weekly praise: score, best day, gym vs. goal |
| **14th** of the month, 10:00 | Tax payment reminder |

> **The mail check does not spam.** The bot remembers (on disk) which messages it already
> reported, so the same unread mail is never announced twice. Once you read a message it
> drops out of that record. It stays quiet overnight — the default schedule is
> `0 8-22 * * *`.

All schedules are configurable through the `*_CRON` variables and follow `TIMEZONE`.

---

## Troubleshooting

### Mail is not sent — `Connection timeout`
The hosting provider (Hetzner and others) blocks **outbound SMTP ports** (465 and 587).
**Fix:** use `RESEND_API_KEY` — sending then goes over HTTPS (port 443). The domain must
be verified in Resend for `From` to be your own address.

### Notion: `Could not find database with ID`
The integration has no access, or it lives in the **wrong workspace**. Make sure it was
created in the same workspace as the pages, then add the parent page under
**Content access**.

### Drive: `Google Drive API has not been used in project…`
Enable the **Google Drive API** for that project in the Google Cloud console, then wait
a minute.

### Drive: `insufficient scope`
The token was issued for Calendar only. Re-run `npm run auth:google` (the script requests
Calendar + Drive) and replace `GOOGLE_REFRESH_TOKEN`.

### Calendar stops working after ~7 days
The Google OAuth app is still in **Testing** mode. Publish it (**Production**) and
generate a new token.

### The bot forgets what you were talking about
The persistent volume at `/app/data` is missing (see [Deployment](#deployment-coolify)).
History is stored in `DATA_DIR/histories.json`.

### The bot restarts in a loop
Usually the **Health Check** is enabled in Coolify (the bot has no HTTP endpoint) —
disable it. Errors while handling a single message no longer crash the process
(`bot.catch`).

### `409 Conflict: terminated by other getUpdates`
Two bot instances are running at once (e.g. a local `npm start` plus the server). Only
one is allowed.

### The daily row is not created at 5:00
Something else already occupies that date — for example a template row with a `Datum`
value. Row creation is idempotent, so an existing row for that date is left untouched.
Clear the date on the template row.

---

## Notes

- **Secrets** (`.env`) never go into git — on the server they live as Environment Variables.
- **Sending email** always requires your explicit confirmation first.
- **Conversation history** keeps the last 12 exchanges; trimming never breaks
  `tool_use`/`tool_result` pairs.
- **Replies always use Latin script** and no Markdown formatting (Telegram does not
  render it in this mode).
- **Daily rows are idempotent** — the 5:00 job never creates a duplicate for a date that
  already has one.
