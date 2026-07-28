import cron from 'node-cron';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { sendMessage } from './telegram.js';
import { generateText } from './claude.js';
import * as calendar from './calendar.js';
import * as notion from './notion.js';
import { checkAllSites, formatReport } from './monitor.js';
import { getForecastLine } from './weather.js';
import * as mail from './mail.js';
import * as checklist from './checklist.js';
import * as dnevnik from './dnevnik.js';
import * as todo from './todo.js';
import { loadState, saveState } from '../store.js';
import * as jobs from './jobs.js';

/**
 * Scheduler — proaktivni podsetnici preko cron izraza.
 *
 *   1. Jutarnji pregled — svaki dan u 10:00.
 *   2. Podsetnik za porez — 14. u mesecu u 10:00.
 *   3. Tiha provera sajtova — svaki dan u 10:00 (javi samo ako ima problema).
 *   4. Pun izveštaj o sajtovima — svaki dan u 18:00 (uvek javi).
 *
 * Cron izrazi i vremenska zona dolaze iz config-a.
 */

export function startScheduler() {
  const options = { timezone: config.timezone };

  cron.schedule(config.cron.morningGreeting, () => jobs.pokreni('jutarnji pozdrav', jutarnjiPozdrav), options);
  logger.info(`Zakazan jutarnji pozdrav: "${config.cron.morningGreeting}" (${config.timezone})`);

  cron.schedule(config.cron.morningBriefing, () => jobs.pokreni('poslovni pregled', morningBriefing), options);
  logger.info(`Zakazan poslovni pregled: "${config.cron.morningBriefing}" (${config.timezone})`);

  cron.schedule(config.cron.taxReminder, () => jobs.pokreni('podsetnik za porez', taxReminder), options);
  logger.info(`Zakazan podsetnik za porez: "${config.cron.taxReminder}" (${config.timezone})`);

  if (featureEnabled.siteMonitor) {
    cron.schedule(config.cron.siteCheckSilent, () => jobs.pokreni('provera sajtova (tiho)', () => siteCheck(false)), options);
    cron.schedule(config.cron.siteCheckReport, () => jobs.pokreni('izvestaj o sajtovima', () => siteCheck(true)), options);
    logger.info(
      `Zakazan monitoring sajtova: tiho "${config.cron.siteCheckSilent}", ` +
        `izveštaj "${config.cron.siteCheckReport}" (${config.timezone})`,
    );
  } else {
    logger.info('Monitoring sajtova preskočen (NOTION_CLIENTS_DB_ID nije podešen).');
  }

  if (featureEnabled.mail) {
    cron.schedule(config.cron.mailCheck, () => jobs.pokreni('provera mejlova', mailCheck), options);
    logger.info(`Zakazana provera mejlova: "${config.cron.mailCheck}" (${config.timezone})`);
  } else {
    logger.info('Provera mejlova preskočena (IMAP nije podešen).');
  }

  if (featureEnabled.checklist) {
    cron.schedule(config.cron.checklistCreate, () => jobs.pokreni('priprema dana', noviDan), options);
    cron.schedule(config.cron.checklistReminder, () => jobs.pokreni('vecernji podsetnik', checklistPodsetnik), options);
    cron.schedule(config.cron.checklistPraise, () => jobs.pokreni('cestitka', checklistCestitka), options);
    cron.schedule(config.cron.weeklySummary, () => jobs.pokreni('nedeljna pohvala', nedeljnaPohvala), options);
    logger.info(
      `Zakazana checklista: nov dan "${config.cron.checklistCreate}", ` +
        `podsetnik "${config.cron.checklistReminder}", čestitka "${config.cron.checklistPraise}", ` +
        `nedeljna pohvala "${config.cron.weeklySummary}" (${config.timezone})`,
    );
  } else {
    logger.info('Dnevna checklista preskočena (NOTION_CHECKLIST_DB_ID nije podešen).');
  }

  if (featureEnabled.todo) {
    cron.schedule(config.cron.flowersTask, () => jobs.pokreni('nedeljni zadatak (cvece)', cveceZadatak), options);
    logger.info(`Zakazan nedeljni zadatak (cveće): "${config.cron.flowersTask}" (${config.timezone})`);
  } else {
    logger.info('To-do lista preskočena (NOTION_TODO_DB_ID nije podešen).');
  }
}

/**
 * Svako jutro u 6:00 — kratka motivaciona poruka + vremenska prognoza.
 * Ovo je "lični" deo jutra; poslovni pregled ide kasnije (9:30).
 */
async function jutarnjiPozdrav() {
  logger.info('Šaljem jutarnji pozdrav...');
  try {
    const prognoza = featureEnabled.weather ? await getForecastLine() : null;

    const text = await generateText(
      'Napiši kratku jutarnju poruku korisniku, na srpskom, latinicom, bez Markdown ' +
        'formatiranja. Ton: energičan i podsticajan, kao dobar prijatelj — u duhu ' +
        '"danas je nov dan, idemo jako". Maksimalno 3 rečenice, bez patetike i bez klišea ' +
        'tipa "grabi dan". Ako je data prognoza, prirodno je uklopi (npr. da obuče nešto ' +
        'lakše ili ponese kišobran). Koristi ISKLJUČIVO podatke ispod — ništa ne izmišljaj.\n\n' +
        (prognoza ? `Prognoza: ${prognoza}` : 'Prognoza nije dostupna — ne pominji vreme.'),
    );

    await sendMessage(`🌅 Dobro jutro!\n\n${text}`);
    logger.info('Jutarnji pozdrav poslat.');
  } catch (err) {
    logger.error('Greška pri slanju jutarnjeg pozdrava:', err.message);
    throw err; // propusti dalje da retry i evidencija poslova vide pad
  }
}

/**
 * Svako jutro u 5:00 — pripremi dan: red u checklisti i zapis u dnevniku,
 * međusobno povezane. Tiho je (bez poruke), samo priprema tabele.
 */
async function noviDan() {
  try {
    const red = await checklist.kreirajRed();
    logger.info(
      red.većPostojao
        ? `Checklista: red za ${red.datum} je već postojao.`
        : `Checklista: napravljen red za ${red.datum} (${red.dan}).`,
    );

    if (featureEnabled.dnevnik) {
      const zapis = await dnevnik.kreirajRed(red.datum, red.id);
      logger.info(
        zapis.većPostojao
          ? `Dnevnik: zapis za ${red.datum} je već postojao.`
          : `Dnevnik: napravljen zapis za ${red.datum}.`,
      );
    }
  } catch (err) {
    logger.error('Greška pri pripremi novog dana:', err.message);
    throw err;
  }
}

/**
 * Ponedeljkom u 5:00 — nedeljni zadatak "cveće za Sofiju" (rok: nedelja).
 */
async function cveceZadatak() {
  try {
    const z = await todo.kreirajCvece();
    if (z.većPostojao) {
      logger.info('Cveće: zadatak za ovu nedelju je već postojao.');
      return;
    }
    await sendMessage(
      `💐 Nova nedelja — dodao sam ti zadatak: „${z.zadatak}" (rok: ${z.rok}).\n` +
        'Podsetiću te dok ne bude gotov.',
    );
  } catch (err) {
    logger.error('Greška pri kreiranju zadatka za cveće:', err.message);
    throw err;
  }
}

/**
 * U 23:00 — čestitka ako je dan popunjen preko praga (default 70%).
 * Ako nije, ćuti (nema prozivanja).
 */
async function checklistCestitka() {
  try {
    const s = await checklist.stanje();
    if (!s.postoji) return;

    const procenat = Math.round((s.urađeno / s.ukupno) * 100);
    if (procenat <= config.checklistPraiseThreshold) {
      logger.info(`Čestitka preskočena — ${procenat}% (prag ${config.checklistPraiseThreshold}%).`);
      return;
    }

    await sendMessage(
      `🎉 Čestitam, uspeo si! Danas si bolji čovek.\n\n` +
        `Skor za ${s.dan.toLowerCase()}: ${s.urađeno}/${s.ukupno} (${procenat}%).`,
    );
    logger.info(`Čestitka poslata — ${procenat}%.`);
  } catch (err) {
    logger.error('Greška pri slanju čestitke:', err.message);
    throw err;
  }
}

/**
 * Nedeljom uveče — pohvala za celu nedelju (pon–ned): skor, najbolji dan,
 * teretana u odnosu na cilj. Tekst piše Claude na osnovu stvarnih brojeva.
 */
async function nedeljnaPohvala() {
  try {
    const r = await checklist.nedeljniRezime();
    const t = r.teretana;

    const text = await generateText(
      'Napiši kratku, toplu poruku pohvale korisniku za proteklu nedelju, na srpskom, ' +
        'latinicom, bez Markdown formatiranja. Budi konkretan i koristi ISKLJUČIVO brojeve ' +
        'ispod — ne izmišljaj. Ako cilj teretane nije ispunjen, ohrabri ga za sledeću nedelju ' +
        'bez prozivanja. Maksimalno 5 rečenica.\n\n' +
        `Nedelja: ${r.odPonedeljka} do ${r.doNedelje}\n` +
        `Popunjenih dana: ${r.brojDana}\n` +
        `Ukupno označenih stavki: ${r.ukupnoStavki} od ${r.maksimum} (${r.procenat}%)\n` +
        `Najbolji dan: ${r.najboljiDan ? `${r.najboljiDan.dan} (${r.najboljiDan.skor}/15)` : 'nema podataka'}\n` +
        `Teretana: ${t.bilo} od ${t.cilj} puta (cilj ${t.ispunjen ? 'ispunjen' : 'nije ispunjen'})`,
    );

    await sendMessage(`🏁 Kraj nedelje!\n\n${text}`);
    logger.info(`Nedeljna pohvala poslata (${r.procenat}%, teretana ${t.bilo}/${t.cilj}).`);
  } catch (err) {
    logger.error('Greška pri slanju nedeljne pohvale:', err.message);
    throw err;
  }
}

/**
 * Svako veče u 21:30 — podseti da se popuni checklista i javi šta fali,
 * plus napredak teretane za tekuću nedelju (cilj: min 3 puta).
 */
async function checklistPodsetnik() {
  try {
    const s = await checklist.stanje();

    if (!s.postoji) {
      await sendMessage(
        '📋 Podsetnik: današnji red u dnevnoj checklisti još ne postoji. ' +
          'Napiši mi šta si danas uradio pa ću ga popuniti.',
      );
      return;
    }

    const t = s.teretana;
    const teretanaLinija = t.ispunjen
      ? `💪 Teretana ove nedelje: ${t.bilo}/${t.cilj} — cilj ispunjen!`
      : `💪 Teretana ove nedelje: ${t.bilo}/${t.cilj} — fali još ${t.ostalo}.`;

    // Dnevnik — javi samo ako nije popunjen za taj dan.
    let dnevnikLinija = '';
    if (featureEnabled.dnevnik) {
      try {
        const d = await dnevnik.stanje();
        if (!d.postoji) {
          dnevnikLinija = '\n\n📓 Dnevnik za danas još nije popunjen.';
        } else if (!d.popunjen) {
          dnevnikLinija = `\n\n📓 U dnevniku fali: ${d.prazno.join(', ')}.`;
        }
      } catch (err) {
        logger.error('Ne mogu da pročitam dnevnik za podsetnik:', err.message);
      }
    }

    // Nedeljni zadatak za cveće — javi ako još nije gotov.
    let cveceLinija = '';
    if (featureEnabled.todo) {
      try {
        const z = await todo.nadjiCvece();
        if (z && z.status !== 'Done') {
          cveceLinija = `\n\n💐 Još nisi kupio cveće Sofiji (rok: ${z.rok}).`;
        }
      } catch (err) {
        logger.error('Ne mogu da proverim zadatak za cveće:', err.message);
      }
    }

    const dodaci = `${dnevnikLinija}${cveceLinija}`;

    if (s.fali.length === 0) {
      await sendMessage(
        `📋 Svaka čast — sve stavke za danas su označene (${s.urađeno}/${s.ukupno}). ✅\n\n` +
          `${teretanaLinija}${dodaci}`,
      );
      return;
    }

    const lista = s.fali.map((x) => `• ${x}`).join('\n');
    await sendMessage(
      `📋 Podsetnik: popuni dnevnu checklistu (${s.dan}).\n\n` +
        `Trenutno ${s.urađeno}/${s.ukupno}. Neoznačeno:\n${lista}\n\n${teretanaLinija}${dodaci}\n\n` +
        'Samo mi napiši šta si uradio (npr. „popio sam kreatin, nisam pio kolu").',
    );
  } catch (err) {
    logger.error('Greška pri slanju podsetnika za checklistu:', err.message);
    throw err;
  }
}

/**
 * Periodična provera nepročitanih mejlova.
 *
 * Javlja SAMO o mejlovima o kojima ranije nije javio — inače bi ti isti
 * nepročitan mejl stizao svakog sata. Lista UID-ova o kojima je javljeno
 * čuva se na disk (preživi restart) i sama se čisti: kad mejl pročitaš,
 * ispada iz nepročitanih pa i iz te liste.
 */
async function mailCheck() {
  try {
    const unread = await mail.listUnread({ limit: 15 });

    // Prethodno javljeni UID-ovi (sa diska).
    const notified = new Set(loadState('notified-mail', []));
    const fresh = unread.filter((m) => !notified.has(m.uid));

    // Novo stanje = trenutno nepročitani (pročitani automatski ispadaju).
    saveState('notified-mail', unread.map((m) => m.uid));

    if (fresh.length === 0) {
      logger.debug(`Provera mejlova: nema novih (ukupno nepročitanih: ${unread.length}).`);
      return;
    }

    const lines = fresh.map((m) => `• ${m.subject}\n  od: ${m.from}`);
    const naslov =
      fresh.length === 1 ? 'Imaš 1 nov nepročitan mejl:' : `Imaš ${fresh.length} nova nepročitana mejla:`;
    const ostatak =
      unread.length > fresh.length ? `\n\n(ukupno nepročitanih: ${unread.length})` : '';

    await sendMessage(`📬 ${naslov}\n\n${lines.join('\n')}${ostatak}`);
    logger.info(`Provera mejlova: javljeno o ${fresh.length} novih mejlova.`);
  } catch (err) {
    // Ne diži buku svakog sata ako IMAP zezne — loguj i propusti da retry proba ponovo.
    logger.error('Greška pri proveri mejlova:', err.message);
    throw err;
  }
}

/**
 * Skuplja današnje događaje i otvorene zadatke, pa traži od Claude-a lep pregled.
 */
async function morningBriefing() {
  logger.info('Pokrećem jutarnji pregled...');
  try {
    const parts = [];

    // Prognoza NAMERNO nije ovde — ona ide u jutarnji pozdrav u 6:00.

    if (featureEnabled.calendar) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const events = await calendar.listEvents({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
      });
      parts.push(`Današnji događaji iz kalendara:\n${JSON.stringify(events, null, 2)}`);
    }

    if (featureEnabled.notionTasks) {
      // Samo otvoreni zadaci — završeni ne trebaju u jutarnjem pregledu.
      const notStarted = await notion.listTasks({ status: 'Not started', limit: 15 });
      const inProgress = await notion.listTasks({ status: 'In progress', limit: 15 });
      parts.push(
        `Otvoreni zadaci iz Notion-a:\n${JSON.stringify([...inProgress, ...notStarted], null, 2)}`,
      );
    }

    if (featureEnabled.mail) {
      try {
        const unread = await mail.listUnread({ limit: 15 });
        const sazeto = unread.map((m) => ({ od: m.from, naslov: m.subject }));
        parts.push(
          `Nepročitani mejlovi (ukupno ${unread.length}):\n${JSON.stringify(sazeto, null, 2)}`,
        );
        // Da satna provera u 10:00 ne javi iste mejlove još jednom.
        saveState('notified-mail', unread.map((m) => m.uid));
      } catch (err) {
        logger.error('Ne mogu da pročitam mejlove za jutarnji pregled:', err.message);
      }
    }

    const raw = parts.length
      ? parts.join('\n\n')
      : 'Nema dostupnih podataka iz kalendara ni Notion-a.';

    const text = await generateText(
      `Napravi poslovni pregled dana na srpskom na osnovu ovih podataka. ` +
        `NE pominji vreme ni vremensku prognozu — to je korisnik već dobio ranije. ` +
        `Redosled: prvo raspored iz kalendara (sastanci po vremenu), zatim zadaci, ` +
        `pa na kraju nepročitani mejlovi (koliko ih ima i za svaki pošiljalac i naslov). ` +
        `Ako neke od tih stavki nema, reci to jednom kratkom rečenicom. ` +
        `Budi konkretan i sažet.\n\n${raw}`,
    );

    await sendMessage(
      `💼 Hej, sad kad si obavio sve jutarnje rituale — prelazimo na posao.\n\n${text}`,
    );
  } catch (err) {
    logger.error('Greška u poslovnom pregledu:', err);
    throw err; // jobs.pokreni ponavlja, pa javi tek ako svi pokušaji padnu
  }
}

/**
 * Provera dostupnosti sajtova klijenata.
 *
 * @param {boolean} full - true = pun izveštaj (18:00, uvek šalje),
 *                         false = tiho (10:00, šalje samo ako ima problema).
 */
async function siteCheck(full) {
  logger.info(`Pokrećem proveru sajtova (${full ? 'pun izveštaj' : 'tiho'})...`);
  try {
    const data = await checkAllSites();
    const message = formatReport(data, full);
    if (message) {
      await sendMessage(message);
    } else {
      logger.info('Monitoring: svi sajtovi OK — tihi režim, ne šaljem poruku.');
    }
  } catch (err) {
    logger.error('Greška u proveri sajtova:', err);
    // I u tihom režimu javljamo grešku samog monitoringa — inače bi tiho zakazao.
    await sendMessage(
      '🌐 Nisam uspeo da proverim sajtove (greška u monitoringu ili Notion bazi).',
    ).catch(() => {});
  }
}

/**
 * Mesečni podsetnik za plaćanje poreza.
 */
async function taxReminder() {
  logger.info('Šaljem podsetnik za porez...');
  try {
    await sendMessage(
      '🧾 Podsetnik: danas je 14. u mesecu — vreme je da platiš porez i doprinose. ' +
        'Ne zaboravi da izmiriš obaveze na vreme.',
    );
  } catch (err) {
    logger.error('Greška pri slanju podsetnika za porez:', err);
  }
}
