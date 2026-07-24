# APU — Lični Telegram AI asistent

Telegram bot pokretan Claude modelom (Anthropic API) koji preko **Tool Calling**-a
upravlja tvojim **Notion** bazama, **Google Calendar**-om i **email**-om, i šalje
proaktivne podsetnike preko **cron**-a.

Sva "pamet" i pozivi alata idu kroz Claude — bot samo prosleđuje tvoje poruke
modelu i vraća odgovor na srpskom.

---

## Funkcionalnosti

- 🤖 **Telegram bot** — sluša tvoje poruke i odgovara prirodno na srpskom.
- 🧠 **Claude tool calling** — model sam bira i poziva alate kad su potrebni.
- 🗂️ **Notion** — čitanje i upis u baze *faktura* i *održavanja*.
- 📅 **Google Calendar** — pregled, traženje slobodnih termina, zakazivanje
  sastanaka (lokacija, vreme, učesnici + pozivnice).
- ✉️ **Email (IMAP/SMTP)** — čitanje nepročitanih, pravljenje draftova, slanje odgovora.
- 🌐 **Monitoring sajtova** — dva puta dnevno proverava da li su sajtovi
  klijenata (iz Notion **KLIJENTI** baze, status *Aktivan*) dostupni i dovoljno
  brzi; možeš i ručno da pitaš „jesu li sajtovi OK?".
- ⏰ **Proaktivni podsetnici**:
  - svaki dan u **10:00** — jutarnji pregled sastanaka i zadataka,
  - svaki dan u **10:00** — tiha provera sajtova (javi samo ako nešto ne radi),
  - svaki dan u **18:00** — pun izveštaj o stanju sajtova,
  - svakog **14. u mesecu u 10:00** — podsetnik za plaćanje poreza.

---

## Struktura projekta

```
apu/
├── .env.example          # sve potrebne promenljive okruženja
├── package.json
├── scripts/
│   └── google-auth.js     # jednokratno dobijanje Google refresh tokena
└── src/
    ├── index.js           # glavni ulaz (bot + scheduler)
    ├── config.js          # učitavanje i validacija konfiguracije
    ├── logger.js
    ├── services/
    │   ├── telegram.js     # Telegram sloj (Telegraf)
    │   ├── claude.js       # Anthropic klijent + agentic loop
    │   ├── notion.js       # Notion integracija
    │   ├── calendar.js     # Google Calendar integracija
    │   ├── mail.js         # IMAP/SMTP integracija
    │   └── scheduler.js    # cron podsetnici
    └── tools/
        ├── definitions.js  # definicije alata (Anthropic format)
        └── index.js        # dispečer koji poziva servise
```

---

## Instalacija

```bash
npm install
cp .env.example .env
# popuni .env vrednostima (vidi ispod)
```

### 1. Telegram
1. Otvori [@BotFather](https://t.me/BotFather) → `/newbot` → dobiješ **TELEGRAM_BOT_TOKEN**.
2. Pošalji poruku [@userinfobot](https://t.me/userinfobot) da saznaš svoj **TELEGRAM_OWNER_CHAT_ID**.

### 2. Anthropic
- Uzmi ključ na <https://console.anthropic.com> → **ANTHROPIC_API_KEY**.
- Model je podrazumevano `claude-sonnet-5` (Claude 3.5 Sonnet je povučen sa API-ja).
  Za maksimalnu pamet stavi `claude-opus-4-8` u `ANTHROPIC_MODEL`.

### 3. Notion
1. Napravi internal integraciju: <https://www.notion.so/my-integrations> → **NOTION_API_KEY**.
2. U Notion-u otvori svaku bazu → *⋯ → Connections → dodaj integraciju*.
3. Iz URL-a baza uzmi ID-eve → **NOTION_INVOICES_DB_ID**, **NOTION_MAINTENANCE_DB_ID**.

### 4. Google Calendar
1. U [Google Cloud Console](https://console.cloud.google.com) napravi OAuth 2.0
   *Desktop* kredencijale → **GOOGLE_CLIENT_ID**, **GOOGLE_CLIENT_SECRET**.
2. Uključi *Google Calendar API*.
3. Pokreni jednokratno:
   ```bash
   npm run auth:google
   ```
   Odobri pristup u browseru i nalepi ispisani **GOOGLE_REFRESH_TOKEN** u `.env`.

### 5. Email
- Za Gmail napravi [App Password](https://myaccount.google.com/apppasswords) i
  koristi ga za **IMAP_PASSWORD** i **SMTP_PASSWORD**.
- Za druge provajdere podesi odgovarajuće `IMAP_*` i `SMTP_*` vrednosti.

---

## Pokretanje

```bash
npm start        # produkcija
npm run dev      # sa auto-reload (node --watch)
```

Bot koristi *long polling* — nije potreban javni server ni webhook.

### Komande u Telegramu
- `/start` — pozdrav.
- `/reset` — briše istoriju razgovora.
- Sve ostalo — pišeš prirodno, npr:
  - *„Šta imam sutra u kalendaru?"*
  - *„Zakaži sastanak sa Markom u utorak u 14h, lokacija kancelarija."*
  - *„Pročitaj mi nepročitane mejlove i napravi draft odgovora na onaj od banke."*
  - *„Dodaj fakturu 001, iznos 15000, status neplaćeno."*

---

## Napomene

- Bot odgovara **samo vlasniku** (`TELEGRAM_OWNER_CHAT_ID`) — poruke drugih se ignorišu.
- Alati čiji servisi nisu konfigurisani se automatski isključuju (model ih ne vidi),
  pa možeš da kreneš samo sa Telegram + Claude, i da dodaješ integracije postepeno.
- **mail_send** šalje odmah; asistent je uputstvom navođen da prvo traži tvoju potvrdu.
- Nazivi Notion kolona u kodu se čitaju dinamički; pri upisu prilagodi nazive
  kolona onako kako se zaista zovu u tvojim bazama.
- Istorija razgovora se čuva u memoriji (nestaje pri restartu). Po želji je zameni
  trajnom bazom.
```
