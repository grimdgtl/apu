import { Client } from '@notionhq/client';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { loadState, saveState } from '../store.js';

/**
 * Provera da Notion baze i dalje izgledaju onako kako kod očekuje.
 *
 * Bot mapira kolone PO IMENU. Kad se kolona u Notion-u preimenuje ili obriše,
 * posledica je najčešće nevidljiva: čitanje vrati `false`, pa navika godinama
 * izgleda kao neurađena a skor tiho laže. Gore je kad se ime koristi u
 * filteru (npr. ciljna stavka za nedeljni cilj) — tada Notion vrati 400 i
 * ceo posao padne.
 *
 * Zato se pri svakom pokretanju šeme uporede sa očekivanim, a razlika javi
 * u Telegram. Provera je informativna: ništa ne menja i ne prekida start.
 */

let client = null;
function getClient() {
  if (!client) client = new Client({ auth: config.notion.apiKey });
  return client;
}

/**
 * Šta kod zahteva od svake baze. Navedene su samo kolone bez kojih nešto
 * stvarno pukne — opciona polja (PIB, telefon…) se namerno ne traže.
 *
 * `tip` je Notion tip kolone; `select` i `status` su različiti tipovi i lako
 * se zamene pri ručnom pravljenju baze.
 */
function ocekivaneBaze() {
  const baze = [];

  if (featureEnabled.notionTasks) {
    baze.push({
      naziv: 'TASK BOARD',
      dbId: config.notion.tasksDbId,
      kolone: [
        { ime: 'Name', tip: 'title' },
        { ime: 'Status', tip: 'status' },
      ],
    });
  }

  if (featureEnabled.notionClients) {
    baze.push({
      naziv: 'KLIJENTI',
      dbId: config.notion.clientsDbId,
      kolone: [
        { ime: 'Klijent', tip: 'title' },
        { ime: 'Domen', tip: 'url' },
        { ime: 'Aktivan', tip: 'select' },
      ],
    });
  }

  if (featureEnabled.birthdays) {
    baze.push({
      naziv: 'Rođendani',
      dbId: config.notion.birthdaysDbId,
      kolone: [
        { ime: 'Ime i prezime', tip: 'title' },
        { ime: 'Rođendan', tip: 'date' },
      ],
    });
  }

  // Namerno po ID-u baze, a ne po featureEnabled.invoices: izrada faktura
  // traži i Drive, ali baza FAKTURE vredi provere i kad Drive nije podešen.
  if (config.notion.apiKey && config.notion.invoicesDbId) {
    baze.push({
      naziv: 'FAKTURE',
      dbId: config.notion.invoicesDbId,
      kolone: [
        { ime: 'Broj', tip: 'title' },
        { ime: 'Datum izdavanja', tip: 'date' },
        { ime: 'Datum prometa', tip: 'date' },
        { ime: 'Iznos', tip: 'number' },
        { ime: 'Status', tip: 'select' },
      ],
    });
  }

  if (featureEnabled.checklist) {
    const stavke = [...config.checklist.pozitivne, ...config.checklist.izbegavanja];
    baze.push({
      naziv: 'Dnevna checklista',
      dbId: config.notion.checklistDbId,
      kolone: [
        { ime: 'Dan', tip: 'title' },
        { ime: 'Datum', tip: 'date' },
        ...stavke.map((ime) => ({ ime, tip: 'checkbox' })),
      ],
      // Jedina baza čija imena kolona zadaje korisnik kroz .env, pa je jedina
      // gde ima smisla javiti i za kolone koje postoje a NISU praćene.
      prijaviNepracene: 'checkbox',
      // Ime koje ide u Notion filter — greška ovde ruši posao, ne ćuti.
      uFilteru: config.checklist.ciljnaStavka,
    });
  }

  if (featureEnabled.dnevnik) {
    baze.push({
      naziv: 'Dnevnik',
      dbId: config.notion.dnevnikDbId,
      kolone: [
        { ime: 'Dan', tip: 'title' },
        { ime: 'Datum', tip: 'date' },
        { ime: 'Raspoloženje', tip: 'select' },
        { ime: 'Energija', tip: 'select' },
        { ime: 'Ključna reč', tip: 'rich_text' },
      ],
    });
  }

  if (featureEnabled.todo) {
    baze.push({
      naziv: 'To-do lista',
      dbId: config.notion.todoDbId,
      kolone: [
        { ime: 'Zadatak', tip: 'title' },
        { ime: 'Status', tip: 'status' },
        { ime: 'Rok', tip: 'date' },
      ],
    });
  }

  return baze;
}

/**
 * Poredi očekivano sa stvarnim stanjem u Notion-u.
 * @returns {{provereno: number, nalazi: Array, ok: boolean}}
 */
export async function proveriSeme() {
  const baze = ocekivaneBaze();
  const nalazi = [];

  for (const baza of baze) {
    let stvarne;
    try {
      const res = await getClient().databases.retrieve({ database_id: baza.dbId });
      stvarne = res.properties || {};
    } catch (err) {
      nalazi.push({ baza: baza.naziv, nedostupna: err.message });
      continue;
    }

    const fale = [];
    const pogresanTip = [];

    for (const { ime, tip } of baza.kolone) {
      const stvarna = stvarne[ime];
      if (!stvarna) {
        fale.push({ ime, uFilteru: ime === baza.uFilteru });
      } else if (stvarna.type !== tip) {
        pogresanTip.push({ ime, ocekivano: tip, nadjeno: stvarna.type });
      }
    }

    // Kolone koje u bazi postoje, a kod ih ne prati (samo za checklistu).
    const nepracene = [];
    if (baza.prijaviNepracene) {
      const pracene = new Set(baza.kolone.map((k) => k.ime));
      for (const [ime, prop] of Object.entries(stvarne)) {
        if (prop.type === baza.prijaviNepracene && !pracene.has(ime)) nepracene.push(ime);
      }
    }

    if (fale.length || pogresanTip.length || nepracene.length) {
      nalazi.push({ baza: baza.naziv, fale, pogresanTip, nepracene });
    }
  }

  const ok = nalazi.length === 0;
  logger.info(
    ok
      ? `Provera šema: ${baze.length} baza, sve u redu.`
      : `Provera šema: ${baze.length} baza, problema u ${nalazi.length}.`,
  );
  return { provereno: baze.length, nalazi, ok };
}

/** Čitljiv izveštaj za Telegram. */
export function formatirajProveru({ provereno, nalazi, ok }) {
  if (provereno === 0) return 'Nijedna Notion baza nije podešena — nema šta da se proveri.';
  if (ok) return `✅ Notion šeme su u redu (provereno baza: ${provereno}).`;

  const delovi = nalazi.map((n) => {
    if (n.nedostupna) {
      return `❌ ${n.baza}\n   nedostupna: ${n.nedostupna}`;
    }

    const redovi = [];
    for (const f of n.fale) {
      redovi.push(
        f.uFilteru
          ? `   ❌ nema kolone „${f.ime}" — a koristi se u filteru, pa PADA nedeljni cilj`
          : `   ⚠️ nema kolone „${f.ime}" — uvek se čita kao neurađeno`,
      );
    }
    for (const t of n.pogresanTip) {
      redovi.push(`   ⚠️ „${t.ime}" je tipa ${t.nadjeno}, a očekuje se ${t.ocekivano}`);
    }
    if (n.nepracene?.length) {
      redovi.push(`   ℹ️ u bazi postoji a bot ne prati: ${n.nepracene.join(', ')}`);
    }
    return `${n.baza}\n${redovi.join('\n')}`;
  });

  return (
    `⚠️ Notion šeme se ne poklapaju sa podešavanjima:\n\n${delovi.join('\n\n')}\n\n` +
    'Uskladi nazive kolona u Notion-u ili vrednosti u .env (CHECKLIST_POZITIVNE, ' +
    'CHECKLIST_IZBEGAVANJA, CHECKLIST_CILJNA_STAVKA).'
  );
}

/**
 * Provera pri pokretanju — javi u Telegram samo kad se nalaz PROMENI.
 *
 * Bez toga bi restart u petlji slao istu poruku u nedogled, a i posle
 * svakog redeploya bi stizalo isto upozorenje koje si već video.
 */
export async function proveriPriPokretanju(posalji) {
  try {
    const rezultat = await proveriSeme();
    if (rezultat.provereno === 0) return rezultat;

    const otisak = JSON.stringify(rezultat.nalazi);
    const prethodni = loadState('schema-check', null);

    if (otisak !== prethodni) {
      saveState('schema-check', otisak);
      if (!rezultat.ok) await posalji(formatirajProveru(rezultat));
      else if (prethodni) await posalji('✅ Notion šeme su ponovo usklađene.');
    }

    return rezultat;
  } catch (err) {
    // Provera je pomoćna — njen pad ne sme da spreči pokretanje bota.
    logger.error('Provera šema nije uspela:', err.message);
    return { provereno: 0, nalazi: [], ok: true };
  }
}
