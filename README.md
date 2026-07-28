# APU — lični Telegram AI asistent

Telegram bot pokretan Claude modelom koji preko **tool calling**-a upravlja tvojim
Notion-om, Google Calendar-om, Google Drive-om i mejlom, prati dostupnost sajtova
klijenata i šalje proaktivne podsetnike.

Pišeš mu prirodnim jezikom — tekstom, **glasovnom porukom** ili **slikom** — a on sam
bira koje alate da pozove i izvrši radnju.

```
🎤 / 💬 / 📷  →  Telegram  →  Claude (agentic loop)  →  alati  →  odgovor na srpskom
                                                        ├─ Notion
                                                        ├─ Google Calendar
                                                        ├─ Google Drive
                                                        ├─ Mejl (IMAP + Resend)
                                                        ├─ Prognoza
                                                        └─ Monitoring sajtova
```

---

## Sadržaj

- [Šta ume](#šta-ume)
- [Struktura projekta](#struktura-projekta)
- [Instalacija](#instalacija)
- [Podešavanje integracija](#podešavanje-integracija)
- [Promenljive okruženja](#promenljive-okruženja)
- [Pokretanje](#pokretanje)
- [Deploy (Coolify)](#deploy-coolify)
- [Komande i primeri](#komande-i-primeri)
- [Proaktivni podsetnici](#proaktivni-podsetnici)
- [Rešavanje problema](#rešavanje-problema)

---

## Šta ume

### Ulaz
| Tip | Ponašanje |
|---|---|
| 💬 **Tekst** | Obična poruka. |
| 🎤 **Glasovna** | Transkribuje se Whisper-om, pa se obrađuje kao tekst. Bot **odgovara tekstom**, ne glasom. |
| 📷 **Slika** | Šalje se Claude-u na analizu (npr. „izvuci iznos sa ovog računa"). Podržano: JPEG, PNG, GIF, WebP — kao foto ili kao fajl. |

### Alati koje Claude poziva

| Oblast | Alati |
|---|---|
| **Notion — zadaci** | `notion_add_task`, `notion_list_tasks`, `notion_update_task_status` |
| **Notion — beleške** | `notion_add_knowledge` |
| **Notion — čitanje** | `notion_search`, `notion_read_page` |
| **Google Drive** | `drive_search`, `drive_read`, `drive_create` |
| **Google Calendar** | `calendar_list_events`, `calendar_find_free_slots`, `calendar_create_event` |
| **Mejl** | `mail_list_unread`, `mail_save_draft`, `mail_send` |
| **Prognoza** | `weather_get` |
| **Monitoring sajtova** | `monitor_check_sites` |
| **Izveštaji** | `generate_report` (piše izveštaj u Google Doc) |

Alati čiji servisi nisu konfigurisani **automatski se gase** — model ih ne vidi.
Trenutno stanje proveriš komandom `/status`.

---

## Struktura projekta

```
apu/
├── Dockerfile              # build za Coolify (pozadinski worker, bez HTTP porta)
├── .env.example            # sve promenljive okruženja
├── scripts/
│   └── google-auth.js      # jednokratno dobijanje Google refresh tokena
└── src/
    ├── index.js            # ulaz: pokreće bota + scheduler
    ├── config.js           # konfiguracija + featureEnabled (koji alati su aktivni)
    ├── logger.js
    ├── store.js            # trajno čuvanje istorije razgovora na disk
    ├── services/
    │   ├── telegram.js     # Telegraf: text/voice/photo handleri, komande
    │   ├── claude.js       # Anthropic klijent + agentic loop + system prompt
    │   ├── notion.js       # zadaci, knowledge base, pretraga, čitanje stranice
    │   ├── calendar.js     # pregled, slobodni termini, zakazivanje
    │   ├── drive.js        # pretraga, čitanje, kreiranje dokumenata
    │   ├── mail.js         # IMAP čitanje/draftovi + slanje (Resend ili SMTP)
    │   ├── transcribe.js   # Whisper (OpenAI ili Groq)
    │   ├── weather.js      # Open-Meteo prognoza
    │   ├── monitor.js      # provera dostupnosti sajtova klijenata
    │   ├── reports.js      # generisanje izveštaja u Google Doc
    │   └── scheduler.js    # cron podsetnici
    └── tools/
        ├── definitions.js  # definicije alata (Anthropic format) + feature gating
        └── index.js        # dispečer: ime alata → funkcija servisa
```

---

## Instalacija

Potreban **Node.js ≥ 18.17** (preporučeno 22+).

```bash
git clone https://github.com/grimdgtl/apu.git
cd apu
npm install
cp .env.example .env
```

Zatim popuni `.env` (vidi ispod) i pokreni sa `npm start`.

---

## Podešavanje integracija

### 1. Telegram
1. [@BotFather](https://t.me/BotFather) → `/newbot` → dobiješ **`TELEGRAM_BOT_TOKEN`**.
2. [@userinfobot](https://t.me/userinfobot) → tvoj chat ID → **`TELEGRAM_OWNER_CHAT_ID`**.

> Bot odgovara **samo vlasniku** — poruke svih ostalih se ignorišu.

### 2. Anthropic (Claude)
Ključ sa <https://console.anthropic.com> → **`ANTHROPIC_API_KEY`**.
Model se bira preko `ANTHROPIC_MODEL` (podrazumevano `claude-sonnet-5`; za maksimalnu
sposobnost `claude-opus-4-8`).

### 3. Notion
1. Napravi **internu integraciju**: <https://www.notion.so/my-integrations> → **`NOTION_API_KEY`**.
   - ⚠️ Integracija mora biti u **istom workspace-u** gde su ti stranice.
   - Capabilities: **Read**, **Update**, **Insert** content.
2. Daj joj pristup stranicama: *integracija → **Content access** → dodaj roditeljsku
   stranicu* (pristup se nasleđuje na sve ispod).
3. Uzmi ID-eve iz URL-a (32 znaka):
   - **`NOTION_TASKS_DB_ID`** — baza zadataka (kolone `Name`, `Status`, `Assign`)
   - **`NOTION_KB_PAGE_ID`** — stranica Knowledge Base
   - **`NOTION_CLIENTS_DB_ID`** — baza KLIJENTI (kolone `Klijent`, `Domen`, `Aktivan`) za monitoring

### 4. Google (Calendar + Drive)
1. [Google Cloud Console](https://console.cloud.google.com) → OAuth 2.0 **Desktop** kredencijali →
   **`GOOGLE_CLIENT_ID`**, **`GOOGLE_CLIENT_SECRET`**.
2. Uključi **oba** API-ja: *Google Calendar API* i *Google Drive API*.
3. **OAuth consent screen → Publish app (Production)** — u „Testing" režimu refresh token
   ističe za 7 dana.
4. Jednokratno:
   ```bash
   npm run auth:google
   ```
   Otvori ispisani URL, odobri pristup (traži Calendar + Drive), i nalepi ispisani
   **`GOOGLE_REFRESH_TOKEN`** u `.env`.

### 5. Mejl
- **Čitanje (IMAP):** `IMAP_HOST/PORT/USER/PASSWORD` — kod cPanel-a je to obično
  `mail.tvojdomen.com:993`, korisničko ime je puna adresa.
- **Slanje:** dve opcije —
  - **Resend (preporučeno):** nalog na [resend.com](https://resend.com), verifikuj domen
    (DNS zapisi), pa **`RESEND_API_KEY`**. Ide preko HTTPS-a, pa radi i kad je SMTP blokiran.
  - **SMTP:** `SMTP_HOST/PORT/SECURE/USER/PASSWORD`. Koristi se **samo ako `RESEND_API_KEY` nije postavljen**.

> Mnogi provajderi (npr. Hetzner) blokiraju izlazne SMTP portove — vidi
> [Rešavanje problema](#rešavanje-problema).

### 6. Glasovne poruke
Popuni **jedan** ključ:
- **`OPENAI_API_KEY`** → `whisper-1`
- **`GROQ_API_KEY`** → `whisper-large-v3` (besplatan nivo)

### 7. Prognoza
Ne treba ključ (Open-Meteo). Podesi lokaciju: `WEATHER_LOCATION`, `WEATHER_LAT`, `WEATHER_LON`.

---

## Promenljive okruženja

| Promenljiva | Obavezno | Podrazumevano | Opis |
|---|:---:|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Token od @BotFather |
| `TELEGRAM_OWNER_CHAT_ID` | ✅ | — | Tvoj chat ID (whitelist) |
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API ključ |
| `ANTHROPIC_MODEL` | | `claude-sonnet-5` | Model |
| `NOTION_API_KEY` | | — | Interna Notion integracija |
| `NOTION_TASKS_DB_ID` | | — | Baza zadataka |
| `NOTION_KB_PAGE_ID` | | — | Stranica Knowledge Base |
| `NOTION_CLIENTS_DB_ID` | | — | Baza KLIJENTI (monitoring) |
| `GOOGLE_CLIENT_ID` | | — | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | | — | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | | `http://localhost:3000/oauth2callback` | Za auth skriptu |
| `GOOGLE_REFRESH_TOKEN` | | — | Iz `npm run auth:google` (Calendar + Drive) |
| `GOOGLE_CALENDAR_ID` | | `primary` | Koji kalendar |
| `IMAP_HOST` / `IMAP_PORT` | | — / `993` | Čitanje mejla |
| `IMAP_USER` / `IMAP_PASSWORD` | | — | Puna adresa + lozinka |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | | — / `465` / `true` | Slanje (fallback) |
| `SMTP_USER` / `SMTP_PASSWORD` | | — | Kredencijali |
| `MAIL_FROM_NAME` / `MAIL_FROM_ADDRESS` | | — | Prikazani pošiljalac |
| `RESEND_API_KEY` | | — | Ako postoji → slanje ide preko Resend-a |
| `OPENAI_API_KEY` | | — | Whisper transkripcija |
| `GROQ_API_KEY` | | — | Alternativa za Whisper |
| `TIMEZONE` | | `Europe/Belgrade` | Vremenska zona za cron i termine |
| `WEATHER_LOCATION` | | `Novi Sad` | Ime grada u poruci |
| `WEATHER_LAT` / `WEATHER_LON` | | `45.2671` / `19.8335` | Koordinate |
| `SITE_MONITOR_TIMEOUT_MS` | | `15000` | Prag za „sajt pao" |
| `SITE_MONITOR_SLOW_MS` | | `5000` | Prag za „sporo" |
| `MORNING_BRIEFING_CRON` | | `0 10 * * *` | Jutarnji pregled |
| `TAX_REMINDER_CRON` | | `0 10 14 * *` | Podsetnik za porez |
| `SITE_CHECK_SILENT_CRON` | | `0 10 * * *` | Tiha provera sajtova |
| `SITE_CHECK_REPORT_CRON` | | `0 18 * * *` | Pun izveštaj o sajtovima |
| `MAIL_CHECK_CRON` | | `0 8-22 * * *` | Provera nepročitanih mejlova |
| `DATA_DIR` | | `./data` | Gde se čuva istorija razgovora |

> **`TIMEZONE` ≠ lokacija prognoze.** `TIMEZONE` je vremenska zona (ista za celu Srbiju),
> a grad za prognozu se podešava preko `WEATHER_*`.

---

## Pokretanje

```bash
npm start        # produkcija
npm run dev      # sa auto-reload (node --watch)
```

Bot koristi **long polling** — nije potreban javni server, domen ni webhook.

Pri startu ispisuje koje su integracije aktivne:

```
Aktivne integracije: { notionZadaci: true, notionKb: true, calendar: true,
                       drive: true, mail: true, prognoza: true, glasovne: true }
```

---

## Deploy (Coolify)

Bot je **pozadinski worker** — ne sluša ni na jednom HTTP portu.

1. **New Resource → Application**, izvor GitHub → repo, grana `main`.
2. **Build Pack: Dockerfile**.
3. **Bez domena i porta.** Ostavi Ports/Domains prazno i **isključi Health Check**
   (nema HTTP endpoint-a; uključen health check obara kontejner u petlju).
4. **Storages → Volume Mount** → *Name:* `apu-data`, *Destination Path:* `/app/data`,
   **Source Path prazan**.
   > Bez volumena bot **zaboravlja istoriju razgovora** pri svakom redeployu.
   > Mora **Volume Mount**, ne Directory Mount — kontejner radi kao korisnik `node`
   > i na bind mount-u nema pravo pisanja.
5. **Environment Variables** — prekopiraj sve iz `.env` (fajl nije u gitu).
6. **Deploy.**

> Otvaranje auto-generisanog `sslip.io` URL-a daje **Bad Gateway** — to je očekivano,
> bot nema web sučelje. Status se proverava kroz Logs i kroz Telegram.

---

## Komande i primeri

| Komanda | Šta radi |
|---|---|
| `/start` | Pozdrav |
| `/status` | Prikazuje koje su integracije uključene |
| `/reset` | Briše istoriju razgovora |

Sve ostalo pišeš prirodno:

```
„Šta imam sutra u kalendaru?"
„Zakaži sastanak sa Markom u utorak u 14h, lokacija kancelarija."
„Nađi slobodan termin za sastanak od sat vremena ove nedelje."
„Pročitaj mi nepročitane mejlove."
„Odgovori mu da mi termin odgovara."          → traži potvrdu pre slanja
„Šta imam da radim?"                          → Notion zadaci
„Dodaj mi u taskove: platiti porez do 14."
„Označi 'Eko taksa' kao gotovo."
„Dodaj u knowledge base: Printful — dropshipping."
„Nađi mi na Drive-u pripremu za epizodu."
„Sačuvaj taj dokument u Notion knowledge base." → most Drive → Notion
„Kakvo je vreme?"
„Proveri da li rade sajtovi klijenata."
```

---

## Proaktivni podsetnici

| Kada | Šta |
|---|---|
| Svaki dan **10:00** | Jutarnji pregled: prognoza + današnji sastanci + otvoreni zadaci |
| **Svaki sat, 8–22** | Provera nepročitanih mejlova — javlja **samo o novima** |
| Svaki dan **10:00** | Tiha provera sajtova — javlja **samo ako ima problema** |
| Svaki dan **18:00** | Pun izveštaj o dostupnosti sajtova |
| **14.** u mesecu, 10:00 | Podsetnik za plaćanje poreza |

> **Provera mejlova ne spamuje.** Bot pamti (na disku) o kojim je mejlovima već javio,
> pa isti nepročitan mejl neće prijavljivati svakog sata. Kad mejl pročitaš, ispada iz
> evidencije. Noću ćuti — podrazumevani raspored je `0 8-22 * * *`.

Rasporedi se menjaju preko `*_CRON` promenljivih; koriste `TIMEZONE`.

---

## Rešavanje problema

### Mejlovi se ne šalju — `Connection timeout`
Provajder (Hetzner i sl.) blokira **izlazne SMTP portove** (465 i 587).
**Rešenje:** koristi `RESEND_API_KEY` — slanje ide preko HTTPS-a (port 443).
Domen mora biti verifikovan u Resend-u da bi `From` bila tvoja adresa.

### Notion: `Could not find database with ID`
Integracija nema pristup, ili je u **pogrešnom workspace-u**.
Proveri da je napravljena u istom workspace-u gde su stranice, pa joj u
**Content access** dodaj roditeljsku stranicu.

### Drive: `Google Drive API has not been used in project…`
Uključi **Google Drive API** u Google Cloud konzoli za taj projekat, pa sačekaj minut.

### Drive: `insufficient scope`
Token je izdat samo za Calendar. Pokreni ponovo `npm run auth:google` (skripta traži
Calendar + Drive) i zameni `GOOGLE_REFRESH_TOKEN`.

### Kalendar prestane da radi posle ~7 dana
Google OAuth app je u **Testing** režimu. Objavi je (**Production**) i generiši nov token.

### Bot zaboravlja o čemu ste pričali
Nedostaje persistent volume na `/app/data` (vidi [Deploy](#deploy-coolify)).
Istorija se čuva u `DATA_DIR/histories.json`.

### Bot se restartuje u petlji
Najčešće uključen **Health Check** u Coolify-ju (bot nema HTTP endpoint) — isključi ga.
Greške pojedinačnih poruka više ne ruše proces (`bot.catch`).

### `409 Conflict: terminated by other getUpdates`
Dve instance bota rade istovremeno (npr. lokalni `npm start` + server). Sme samo jedna.

---

## Napomene

- **Tajne** (`.env`) nikad ne idu u git — na serveru se drže kao Environment Variables.
- **Slanje mejla** uvek traži tvoju izričitu potvrdu pre nego što ode.
- **Istorija razgovora** čuva poslednjih 12 razmena; skraćivanje ne kida
  `tool_use`/`tool_result` parove.
- **Odgovori su uvek latinicom** i bez Markdown formatiranja (Telegram ga ne renderuje
  u ovom režimu).
