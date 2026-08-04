import { config } from '../config.js';

/**
 * Definicije alata (Anthropic "tools" format) koje Claude može da pozove.
 *
 * Svaka definicija ima i interno polje `feature` — po njemu se alat uključuje
 * ili gasi zavisno od toga šta je konfigurisano. To polje se skida pre slanja
 * modelu (nije deo Anthropic šeme).
 */

const definitions = [
  // ---------- Notion: zadaci ----------
  {
    feature: 'notionTasks',
    name: 'notion_add_task',
    description:
      'Dodaje novi zadatak u to-do listu (Notion baza TASK BOARD). ' +
      'Koristi kada korisnik kaže npr. "dodaj mi ovo u taskove", "podseti me da uradim X", ' +
      '"ubaci na listu".',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Naziv zadatka, kratko i jasno.' },
        status: {
          type: 'string',
          enum: ['Not started', 'In progress', 'Done'],
          description: 'Status zadatka (podrazumevano "Not started").',
        },
      },
      required: ['title'],
    },
  },
  {
    feature: 'notionTasks',
    name: 'notion_list_tasks',
    description:
      'Vraća zadatke iz to-do liste (TASK BOARD). Koristi za "šta imam da radim", ' +
      '"koji su mi otvoreni taskovi", jutarnji pregled i slično.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['Not started', 'In progress', 'Done'],
          description: 'Opciono filtriraj po statusu.',
        },
        limit: { type: 'number', description: 'Maksimalan broj zadataka (default 25).' },
      },
    },
  },
  {
    feature: 'notionTasks',
    name: 'notion_update_task_status',
    description:
      'Menja status postojećeg zadatka — npr. kad korisnik kaže "označi X kao gotovo". ' +
      'Prvo pozovi notion_list_tasks da nađeš ID zadatka.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'ID zadatka (iz notion_list_tasks).' },
        status: {
          type: 'string',
          enum: ['Not started', 'In progress', 'Done'],
          description: 'Novi status.',
        },
      },
      required: ['taskId', 'status'],
    },
  },

  // ---------- Notion: knowledge base ----------
  {
    feature: 'notionKb',
    name: 'notion_add_knowledge',
    description:
      'Dodaje novu belešku u Knowledge Base (kao pod-stranicu). Koristi kada korisnik kaže ' +
      '"dodaj ovo u knowledge base", "zabeleži ovo", "sačuvaj mi ovaj link/tekst".',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Naslov beleške.' },
        content: {
          type: 'string',
          description: 'Sadržaj beleške. Svaki novi red postaje zaseban pasus.',
        },
      },
      required: ['title'],
    },
  },

  // ---------- Notion: čitanje stranice ----------
  {
    feature: 'notionSearch',
    name: 'notion_read_page',
    description:
      'Čita tekstualni sadržaj Notion stranice. Prvo nađi ID stranice preko ' +
      'notion_search. Koristi npr. kad korisnik traži da se beleška izveze u Drive.',
    input_schema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'ID Notion stranice (iz notion_search).' },
      },
      required: ['pageId'],
    },
  },

  // ---------- Notion: pretraga ----------
  {
    feature: 'notionSearch',
    name: 'notion_search',
    description:
      'Pretražuje ceo Notion workspace (stranice i baze) po tekstu. Koristi kada korisnik ' +
      'traži nešto što je ranije zapisao — "nađi mi ono o...", "gde sam zapisao...".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tekst za pretragu.' },
        limit: { type: 'number', description: 'Maksimalan broj rezultata (default 10).' },
      },
      required: ['query'],
    },
  },

  // ---------- Trajno pamćenje ----------
  {
    feature: 'memory',
    name: 'memory_save',
    description:
      'Trajno pamti činjenicu o korisniku (preživljava restart i brisanje istorije). ' +
      'Koristi kada korisnik kaže nešto što treba da važi ubuduće: ko su mu bliski ljudi, ' +
      'kako voli da mu se piše, kontekst projekta, navike. NE pamti prolazne stvari ' +
      '(dnevni zadaci idu u todo/taskove, raspoloženje u dnevnik). Sve zapamćeno ti je ' +
      'automatski dostupno u svakom razgovoru — ne moraš da ga tražiš.',
    input_schema: {
      type: 'object',
      properties: {
        tekst: {
          type: 'string',
          description: 'Činjenica u jednoj rečenici, npr. "Sofija je korisnikova devojka".',
        },
        kategorija: {
          type: 'string',
          enum: ['osoba', 'preferencija', 'projekat', 'navika', 'ostalo'],
        },
      },
      required: ['tekst'],
    },
  },
  {
    feature: 'memory',
    name: 'memory_list',
    description:
      'Vraća sve trajno zapamćene činjenice sa njihovim ID-evima. Koristi kada korisnik ' +
      'pita "šta znaš o meni" ili kad ti treba ID da nešto izmeniš/obrišeš.',
    input_schema: {
      type: 'object',
      properties: {
        kategorija: {
          type: 'string',
          enum: ['osoba', 'preferencija', 'projekat', 'navika', 'ostalo'],
        },
      },
    },
  },
  {
    feature: 'memory',
    name: 'memory_update',
    description:
      'Menja postojeću zapamćenu činjenicu (kad se nešto promeni). ID nađi preko memory_list ' +
      'ili iz uglastih zagrada u listi činjenica koju već imaš u kontekstu.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID činjenice.' },
        tekst: { type: 'string', description: 'Nov tekst (opciono).' },
        kategorija: {
          type: 'string',
          enum: ['osoba', 'preferencija', 'projekat', 'navika', 'ostalo'],
        },
      },
      required: ['id'],
    },
  },
  {
    feature: 'memory',
    name: 'memory_forget',
    description:
      'Trajno briše zapamćenu činjenicu. Koristi kada korisnik kaže da nešto više ne važi ' +
      'ili izričito traži da zaboraviš.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID činjenice.' } },
      required: ['id'],
    },
  },

  // ---------- Semantička pretraga ----------
  {
    feature: 'semantic',
    name: 'semantic_search',
    description:
      'Pretraga po ZNAČENJU kroz korisnikov Notion i Google Drive. Za razliku od ' +
      'notion_search i drive_search (koji traže doslovnu reč), ovo nalazi i kad se ' +
      'formulacija ne poklapa — npr. "šta sam pisao o onom klijentu u proleće". ' +
      'Koristi kada obična pretraga ne nađe ništa ili kada je upit opisan a ne tačan. ' +
      'Rezultati imaju "ocena" (0-1) — ispod ~0.3 su slabo povezani, ne predstavljaj ih ' +
      'kao pogodak.',
    input_schema: {
      type: 'object',
      properties: {
        upit: { type: 'string', description: 'Šta tražiš, svojim rečima.' },
        limit: { type: 'number', description: 'Broj rezultata (default 5).' },
      },
      required: ['upit'],
    },
  },
  {
    feature: 'semantic',
    name: 'semantic_reindex',
    description:
      'Osvežava indeks za semantičku pretragu (čita Notion i Drive). Traje nekoliko ' +
      'sekundi. Bot ovo radi sam jednom dnevno — pozovi samo ako korisnik izričito traži ' +
      'ili ako pretraga ne nalazi nešto što je tek dodato.',
    input_schema: { type: 'object', properties: {} },
  },

  // ---------- Uptime istorija ----------
  {
    feature: 'siteMonitor',
    name: 'monitor_uptime',
    description:
      'Dostupnost (uptime) sajtova klijenata za period unazad, iz zabeleženih provera. ' +
      'Koristi za "koliko je sajt X bio dostupan ovog meseca", "koji sajt najviše pada", ' +
      'ili kada treba klijentu dati izveštaj. Za razliku od monitor_check_sites (koji ' +
      'proverava SADA), ovo čita istoriju i ne šalje nijedan zahtev ka sajtovima.',
    input_schema: {
      type: 'object',
      properties: {
        dana: { type: 'number', description: 'Period u danima (default 30).' },
        sajt: { type: 'string', description: 'Opciono ime klijenta/sajta (podniz).' },
      },
    },
  },

  // ---------- Uvidi iz navika ----------
  {
    feature: 'checklist',
    name: 'insights_get',
    description:
      'Statistika i uvidi iz dnevne checkliste i dnevnika za period unazad (default 30 dana): ' +
      'prosečan skor, nizovi uspešnih dana, koje stavke se najčešće preskaču, koji dan u nedelji ' +
      'je najbolji, i veza između pojedinih navika i raspoloženja/energije. ' +
      'Koristi kada korisnik pita "kako mi ide", "šta mi najviše smeta", "koji mi je najgori dan". ' +
      'Sve su tvrde brojke — prepričaj ih, ne dodaji zaključke koje podaci ne pokrivaju. ' +
      'Ako rezultat ima polje "napomena", obavezno je pomeni.',
    input_schema: {
      type: 'object',
      properties: {
        dana: { type: 'number', description: 'Koliko dana unazad (default 30).' },
      },
    },
  },

  // ---------- Dnevna checklista ----------
  {
    feature: 'checklist',
    name: 'checklist_get',
    description:
      'Čita dnevnu checklistu navika za dati datum (podrazumevano danas): koje su stavke ' +
      'označene, koje fale, skor, i koliko je puta ove nedelje bio u teretani (cilj: min 3). ' +
      'Koristi za "šta mi fali danas", "koliko sam puta bio u teretani".',
    input_schema: {
      type: 'object',
      properties: {
        datum: { type: 'string', description: 'YYYY-MM-DD (default: danas).' },
      },
    },
  },
  {
    feature: 'checklist',
    name: 'checklist_mark',
    description:
      'Označava (ili skida oznaku) stavke u dnevnoj checklisti. Ako red za taj dan ne postoji, ' +
      'automatski ga kreira.\n' +
      'Dozvoljena imena stavki su TAČNO ova:\n' +
      'Ustajanje 6:00, Teretana 7:00, Kreatin, Doručak, Vitamin D3 i K2, Tuširanje i C serum, ' +
      'Večera 19:00, Magnezijum, Bez Coca-Cole, Bez gazirane vode, Bez alkohola, Bez pušenja, ' +
      'Bez slatkog, Bez igrica, Bez telefona posle 22:00.\n' +
      'VAŽNO — stavke koje počinju sa "Bez " su OBRNUTE: true znači da je uspešno IZBEGAO tu ' +
      'stvar. Primeri: "popio sam kreatin" → {"Kreatin": true}; "nisam pio koka-kolu" → ' +
      '{"Bez Coca-Cole": true}; "pušio sam danas" → {"Bez pušenja": false}; "bio sam u teretani" ' +
      '→ {"Teretana 7:00": true}; "jeo sam slatko" → {"Bez slatkog": false}.',
    input_schema: {
      type: 'object',
      properties: {
        stavke: {
          type: 'object',
          description:
            'Mapa { "Naziv stavke": true/false }. Koristi isključivo nazive iz opisa alata.',
        },
        datum: { type: 'string', description: 'YYYY-MM-DD (default: danas).' },
      },
      required: ['stavke'],
    },
  },
  {
    feature: 'checklist',
    name: 'checklist_create_day',
    description:
      'Kreira nov red u dnevnoj checklisti za dati datum (naslov = ime dana u nedelji). ' +
      'Ako red već postoji, ne pravi duplikat. Bot ovo radi automatski svako jutro u 5:00 — ' +
      'koristi alat samo ako korisnik izričito traži.',
    input_schema: {
      type: 'object',
      properties: {
        datum: { type: 'string', description: 'YYYY-MM-DD (default: danas).' },
      },
    },
  },

  // ---------- Dnevnik ----------
  {
    feature: 'dnevnik',
    name: 'dnevnik_get',
    description:
      'Čita zapis u Dnevniku za dati datum (default danas): raspoloženje, energija, ključna reč ' +
      'i lista polja koja su još prazna.',
    input_schema: {
      type: 'object',
      properties: { datum: { type: 'string', description: 'YYYY-MM-DD (default: danas).' } },
    },
  },
  {
    feature: 'dnevnik',
    name: 'dnevnik_write',
    description:
      'Upisuje dnevnik za dati dan. Ako zapis ne postoji, kreira ga. Upiši samo ona polja koja ' +
      'je korisnik zaista pomenuo.\n' +
      'raspolozenje: Odlično | Dobro | Neutralno | Loše | Teško\n' +
      'energija: Visoka | Srednja | Niska\n' +
      'kljucnaRec: kratka reč/fraza koja opisuje dan (npr. "fokusiran", "naporan dan").\n' +
      'VAŽNO: rezultat sadrži polje "prazno" — ako ono nije prazno, OBAVEZNO pitaj korisnika ' +
      'za ta polja (npr. "Kakva ti je bila energija danas — visoka, srednja ili niska?"). ' +
      'Ne izmišljaj vrednosti koje korisnik nije rekao.',
    input_schema: {
      type: 'object',
      properties: {
        raspolozenje: {
          type: 'string',
          enum: ['Odlično', 'Dobro', 'Neutralno', 'Loše', 'Teško'],
          description: 'Kako se osećao.',
        },
        energija: {
          type: 'string',
          enum: ['Visoka', 'Srednja', 'Niska'],
          description: 'Nivo energije.',
        },
        kljucnaRec: { type: 'string', description: 'Ključna reč ili kratka fraza za taj dan.' },
        datum: { type: 'string', description: 'YYYY-MM-DD (default: danas).' },
      },
    },
  },

  // ---------- To-do lista (lični zadaci) ----------
  {
    feature: 'todo',
    name: 'todo_list',
    description:
      'Vraća lične zadatke sa To-do liste (Life stranica). Podrazumevano samo otvorene. ' +
      'Ovo je LIČNA lista (kućni poslovi, ljudi, zdravlje) — za poslovne zadatke koristi ' +
      'notion_list_tasks.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['Not started', 'In progress', 'Done'] },
        limit: { type: 'number', description: 'Maksimalan broj (default 25).' },
      },
    },
  },
  {
    feature: 'todo',
    name: 'todo_add',
    description: 'Dodaje nov lični zadatak na To-do listu (Life stranica).',
    input_schema: {
      type: 'object',
      properties: {
        zadatak: { type: 'string', description: 'Naziv zadatka.' },
        oblast: {
          type: 'string',
          enum: ['Zdravlje', 'Kuća', 'Finansije', 'Ljudi', 'Učenje', 'Ostalo'],
        },
        prioritet: { type: 'string', enum: ['Visok', 'Srednji', 'Nizak'] },
        rok: { type: 'string', description: 'Rok kao YYYY-MM-DD (opciono).' },
      },
      required: ['zadatak'],
    },
  },
  {
    feature: 'todo',
    name: 'todo_set_status',
    description:
      'Menja status ličnog zadatka — npr. kad korisnik kaže "kupio sam cveće" postavi na "Done". ' +
      'Prvo pozovi todo_list da nađeš ID zadatka.',
    input_schema: {
      type: 'object',
      properties: {
        zadatakId: { type: 'string', description: 'ID zadatka (iz todo_list).' },
        status: { type: 'string', enum: ['Not started', 'In progress', 'Done'] },
      },
      required: ['zadatakId', 'status'],
    },
  },

  // ---------- Google Drive ----------
  {
    feature: 'drive',
    name: 'drive_search',
    description:
      'Pretražuje Google Drive po imenu i sadržaju fajla. Koristi za "nađi mi dokument X".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tekst za pretragu.' },
        limit: { type: 'number', description: 'Maksimalan broj rezultata (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    feature: 'drive',
    name: 'drive_read',
    description:
      'Čita sadržaj fajla sa Drive-a kao tekst (Google Docs, Sheets kao CSV, tekstualni ' +
      'fajlovi). Prvo nađi ID preko drive_search. Za slanje sadržaja u Notion, kombinuj sa ' +
      'notion_add_knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'ID fajla (iz drive_search).' },
      },
      required: ['fileId'],
    },
  },
  {
    feature: 'drive',
    name: 'drive_create',
    description:
      'Kreira novi Google Doc sa zadatim tekstom na Drive-u. Koristi npr. za "sačuvaj ovo kao ' +
      'dokument" ili za izvoz Notion beleške (prvo notion_read_page, pa drive_create).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Naziv dokumenta.' },
        content: { type: 'string', description: 'Tekstualni sadržaj dokumenta.' },
      },
      required: ['name', 'content'],
    },
  },

  // ---------- Google Calendar ----------
  {
    feature: 'calendar',
    name: 'calendar_list_events',
    description:
      'Vraća listu događaja iz kalendara u zadatom vremenskom opsegu. ' +
      'Ako opseg nije zadat, uzima narednih 7 dana.',
    input_schema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'ISO datum/vreme početka opsega.' },
        timeMax: { type: 'string', description: 'ISO datum/vreme kraja opsega.' },
      },
    },
  },
  {
    feature: 'calendar',
    name: 'calendar_find_free_slots',
    description:
      'Pronalazi slobodne termine (rupe u rasporedu) unutar radnog vremena. ' +
      'Koristi pre zakazivanja da bi predložio termin.',
    input_schema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'ISO početak opsega pretrage.' },
        timeMax: { type: 'string', description: 'ISO kraj opsega pretrage.' },
        durationMinutes: {
          type: 'number',
          description: 'Trajanje traženog termina u minutima (default 60).',
        },
        workdayStart: { type: 'number', description: 'Sat početka radnog dana (0-23, default 9).' },
        workdayEnd: { type: 'number', description: 'Sat kraja radnog dana (0-23, default 18).' },
      },
    },
  },
  {
    feature: 'calendar',
    name: 'calendar_create_event',
    description:
      'Zakazuje novi sastanak/događaj u kalendaru. Može da doda lokaciju, opis i ' +
      'učesnike (koji dobijaju pozivnicu na email).',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Naslov sastanka.' },
        start: { type: 'string', description: 'ISO vreme početka.' },
        end: { type: 'string', description: 'ISO vreme kraja.' },
        location: { type: 'string', description: 'Lokacija (opciono).' },
        description: { type: 'string', description: 'Opis/napomena (opciono).' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email adrese učesnika (opciono).',
        },
      },
      required: ['summary', 'start', 'end'],
    },
  },

  // ---------- Mail ----------
  {
    feature: 'mail',
    name: 'mail_list_unread',
    description: 'Vraća nepročitane mejlove iz sandučeta (najnovije prvo), sa pregledom teksta.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maksimalan broj poruka (default 10).' },
      },
    },
  },
  {
    feature: 'mail',
    name: 'mail_save_draft',
    description:
      'Pravi draft (nacrt) odgovora i snima ga u Drafts folder BEZ slanja. ' +
      'Koristi kada korisnik želi da prvo pregleda odgovor.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Email primaoca.' },
        subject: { type: 'string', description: 'Naslov mejla.' },
        body: { type: 'string', description: 'Tekst mejla.' },
        cc: { type: 'string', description: 'CC primaoci (opciono).' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    feature: 'mail',
    name: 'mail_send',
    description:
      'PRIPREMA mejl za slanje i prikazuje ga korisniku sa dugmadima Pošalji/Otkaži. ' +
      'NE šalje mejl — slanje pokreće isključivo korisnik pritiskom na dugme. ' +
      'Kada javljaš ishod, reci da si pripremio mejl i da treba da ga potvrdi dugmetom; ' +
      'NIKADA ne tvrdi da je poslat.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Email primaoca.' },
        subject: { type: 'string', description: 'Naslov mejla.' },
        body: { type: 'string', description: 'Tekst mejla.' },
        cc: { type: 'string', description: 'CC primaoci (opciono).' },
        inReplyTo: { type: 'string', description: 'Message-ID poruke na koju se odgovara (opciono).' },
      },
      required: ['to', 'subject', 'body'],
    },
  },

  // ---------- Monitoring sajtova ----------
  {
    feature: 'siteMonitor',
    name: 'monitor_check_sites',
    description:
      'Odmah proverava da li su svi aktivni sajtovi klijenata dostupni i dovoljno brzi. ' +
      'Lista sajtova se čita iz Notion KLIJENTI baze (samo status "Aktivan"). Koristi kada ' +
      'korisnik pita "jesu li sajtovi OK", "proveri sajtove", "da li je nešto palo". Vraća ' +
      'status, vreme odgovora i eventualne probleme za svaki sajt.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  // ---------- Vreme ----------
  {
    feature: 'weather',
    name: 'weather_get',
    description:
      'Vraća današnju vremensku prognozu (trenutna temperatura, min/max, opis, vetar, ' +
      'verovatnoća padavina) za podešenu lokaciju. Koristi kad korisnik pita "kakvo je vreme", ' +
      '"hoće li padati kiša", "koliko je napolju".',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  // ---------- Fakture ----------
  {
    feature: 'invoices',
    name: 'invoice_create',
    description:
      'PRAVI PDF fakture i šalje ga korisniku na pregled sa dugmadima Sačuvaj/Odbaci. ' +
      'NE snima sam — na Drive i u Notion arhivu ide tek kad korisnik pritisne dugme. ' +
      'Fiskalne podatke klijenta (naziv, adresa, PIB, MB) povlači iz Notion KLIJENTI baze ' +
      'po nazivu — NIKADA ih ne izmišljaj i ne prosleđuj sam. Broj fakture se dodeljuje ' +
      'automatski, ne traži ga od korisnika. Koristi kad korisnik kaže "napravi fakturu za X". ' +
      'Ako fali podatak o iznosu ili opisu usluge, pitaj korisnika umesto da pretpostaviš.',
    input_schema: {
      type: 'object',
      properties: {
        klijent: {
          type: 'string',
          description: 'Naziv klijenta (dovoljan deo naziva) — traži se u KLIJENTI bazi.',
        },
        stavke: {
          type: 'array',
          description: 'Stavke fakture. Obično jedna.',
          items: {
            type: 'object',
            properties: {
              opis: { type: 'string', description: 'Opis usluge kako ide na fakturu.' },
              kolicina: { type: 'number', description: 'Količina (podrazumevano 1).' },
              cena: { type: 'number', description: 'Jedinična cena u RSD, bez tačaka i zareza.' },
            },
            required: ['opis', 'cena'],
          },
        },
        datumIzdavanja: { type: 'string', description: 'ISO datum (YYYY-MM-DD). Default: danas.' },
        datumPrometa: {
          type: 'string',
          description: 'ISO datum prometa usluge. Default: isto kao datum izdavanja.',
        },
        mesto: { type: 'string', description: 'Mesto izdavanja/prometa. Default: sedište firme.' },
      },
      required: ['klijent', 'stavke'],
    },
  },
  {
    feature: 'invoices',
    name: 'invoice_list',
    description:
      'Vraća izdate fakture iz arhive, najnovije prvo. Koristi za "koje sam fakture izdao", ' +
      '"ko mi nije platio" (status "Nije plaćeno"), "koliko sam fakturisao".',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['Nije plaćeno', 'Plaćeno', 'Stornirano'],
          description: 'Opciono filtriranje po statusu naplate.',
        },
        limit: { type: 'number', description: 'Maksimalan broj faktura (default 25).' },
      },
    },
  },

  // ---------- Rođendani ----------
  {
    feature: 'birthdays',
    name: 'birthdays_today',
    description:
      'Vraća ko danas slavi rođendan (ime, koliko puni godina, odnos, telefon, ideja za ' +
      'poklon, napomena). Koristi kada korisnik pita "ko danas slavi", "ima li rođendana".',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    feature: 'birthdays',
    name: 'birthdays_upcoming',
    description:
      'Vraća nadolazeće rođendane, sortirane po tome koliko dana fali. Koristi za ' +
      '"ko slavi ove nedelje", "ko je sledeći na redu za rođendan".',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Koliko dana unapred da gleda (default 30).' },
      },
    },
  },
  {
    feature: 'birthdays',
    name: 'birthday_mark_greeted',
    description:
      'Beleži da je korisnik ČESTITAO rođendan nekome, čime se gasi večernji podsetnik u ' +
      '19:00 za tu osobu. Koristi kad korisnik kaže "čestitao sam Nikoli", "javio sam se ' +
      'Mrđi", "poslao sam poruku za rođendan". Ako danas slavi samo jedna osoba, dovoljno je ' +
      'i "čestitao sam" bez imena. Ako alat vrati ambiguous=true, pitaj korisnika na koga ' +
      'tačno misli i pozovi ponovo sa punijim imenom.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Ime osobe kojoj je čestitano (dovoljno i samo ime, npr. "Nikola"). Ako korisnik ' +
            'nije rekao ime a danas slavi samo jedna osoba, prosledi prazan string.',
        },
      },
      required: ['name'],
    },
  },

  // ---------- Izveštaji ----------
  {
    feature: 'reports',
    name: 'generate_report',
    description:
      'Sastavlja uredan izveštaj iz stvarnih podataka (Notion zadaci po statusu, događaji iz ' +
      'kalendara u opsegu, opciono status sajtova) i čuva ga kao Google Doc, pa vraća link. ' +
      'Koristi kada korisnik kaže "napravi izveštaj", "sumiraj ovu nedelju u dokument", ' +
      '"izveštaj o urađenom". Za nedeljni izveštaj ostavi podrazumevani opseg (poslednjih 7 dana).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Naslov izveštaja (opciono).' },
        instructions: {
          type: 'string',
          description: 'Šta izveštaj treba posebno da obuhvati ili naglasi (opciono).',
        },
        from: { type: 'string', description: 'ISO/date početak opsega za kalendar (default: pre 7 dana).' },
        to: { type: 'string', description: 'ISO/date kraj opsega za kalendar (default: danas).' },
        includeTasks: { type: 'boolean', description: 'Uključi Notion zadatke (default true).' },
        includeCalendar: { type: 'boolean', description: 'Uključi kalendar u opsegu (default true).' },
        includeSites: { type: 'boolean', description: 'Uključi status sajtova (default false).' },
        saveToDoc: { type: 'boolean', description: 'Sačuvaj kao Google Doc (default true).' },
      },
    },
  },
];

export const toolDefinitions = definitions;

/**
 * Vraća alate čiji su servisi konfigurisani, bez internog `feature` polja.
 * @param {Record<string, boolean>} enabled mapa iz config.featureEnabled
 */
export function getEnabledTools(enabled) {
  return definitions
    .filter((t) => enabled[t.feature])
    .map(({ feature, ...tool }) => tool);
}

export const currentTimezone = config.timezone;
