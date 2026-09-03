import { Client } from '@notionhq/client';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { SVE_STAVKE, danasISO, imeDana } from './checklist.js';

/**
 * Uvidi iz dnevne checkliste i dnevnika.
 *
 * Ovo NIJE mašinsko učenje — to bi sa ~30 redova mesečno bio čist šum. Sve su
 * obične brojke: udeli, proseci, nizovi. Prednost je što su proverljive i ne
 * mogu da haluciniraju; Claude ih samo prepričava.
 *
 * Računa se:
 *   - skor po danu i prosek za period
 *   - niz uzastopnih dana (streak) i najduži niz
 *   - koje se stavke najčešće preskaču
 *   - dan u nedelji sa najboljim/najgorim prosekom
 *   - veza između navike i raspoloženja/energije iz dnevnika
 */

const OCENE_RASPOLOZENJA = { Odlično: 5, Dobro: 4, Neutralno: 3, Loše: 2, Teško: 1 };
const OCENE_ENERGIJE = { Visoka: 3, Srednja: 2, Niska: 1 };

let client = null;
function getClient() {
  if (!config.notion.apiKey) throw new Error('Notion nije konfigurisan.');
  if (!client) client = new Client({ auth: config.notion.apiKey });
  return client;
}

function pomeriDatum(iso, dana) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + dana);
  return d.toISOString().slice(0, 10);
}

async function ucitajChecklistu(od, do_) {
  const res = await getClient().databases.query({
    database_id: config.notion.checklistDbId,
    filter: {
      and: [
        { property: 'Datum', date: { on_or_after: od } },
        { property: 'Datum', date: { on_or_before: do_ } },
      ],
    },
    sorts: [{ property: 'Datum', direction: 'ascending' }],
    page_size: 100,
  });

  return res.results.map((p) => {
    const stavke = {};
    for (const naziv of SVE_STAVKE) stavke[naziv] = p.properties[naziv]?.checkbox ?? false;
    return {
      datum: p.properties.Datum?.date?.start ?? null,
      stavke,
      skor: Object.values(stavke).filter(Boolean).length,
    };
  });
}

async function ucitajDnevnik(od, do_) {
  if (!featureEnabled.dnevnik) return [];
  const res = await getClient().databases.query({
    database_id: config.notion.dnevnikDbId,
    filter: {
      and: [
        { property: 'Datum', date: { on_or_after: od } },
        { property: 'Datum', date: { on_or_before: do_ } },
      ],
    },
    page_size: 100,
  });

  return res.results.map((p) => ({
    datum: p.properties.Datum?.date?.start ?? null,
    raspolozenje: p.properties['Raspoloženje']?.select?.name ?? null,
    energija: p.properties['Energija']?.select?.name ?? null,
  }));
}

/**
 * Najduži i tekući niz dana sa skorom >= prag.
 *
 * Broji UZASTOPNE KALENDARSKE DANE, ne uzastopne redove u tabeli. Ako za neki
 * dan red uopšte ne postoji (bot nije radio, dan preskočen), niz se prekida —
 * inače bi dva dobra dana sa nedelju dana rupe između njih davala "niz od 2".
 */
function nizovi(dani, prag) {
  const uRedu = dani
    .filter((d) => d.datum && d.skor >= prag)
    .map((d) => d.datum)
    .sort();

  let najduzi = 0;
  let tekuci = 0;
  let prethodni = null;

  for (const datum of uRedu) {
    const dan = Date.parse(`${datum}T12:00:00Z`);
    // Nastavak niza samo ako je tačno dan posle prethodnog.
    tekuci = prethodni !== null && dan - prethodni === 86_400_000 ? tekuci + 1 : 1;
    najduzi = Math.max(najduzi, tekuci);
    prethodni = dan;
  }

  return { tekuci, najduzi };
}

/**
 * Veza između jedne navike i prosečne ocene (raspoloženje ili energija).
 * Vraća null ako nema dovoljno podataka na obe strane — bolje ćutati nego
 * tvrditi nešto na osnovu jednog dana.
 */
function veza(dani, mapaOcena, stavka, minPoGrupi = 3) {
  const sa = [];
  const bez = [];
  for (const d of dani) {
    // hasOwn — da naziv opcije tipa "constructor" ne pokupi funkciju sa
    // prototipa i pretvori prosek u NaN.
    const ocena = Object.hasOwn(mapaOcena, d.ocena) ? mapaOcena[d.ocena] : null;
    if (ocena == null) continue;
    (d.stavke[stavka] ? sa : bez).push(ocena);
  }
  if (sa.length < minPoGrupi || bez.length < minPoGrupi) return null;

  const prosek = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const razlika = prosek(sa) - prosek(bez);
  return {
    stavka,
    danaSa: sa.length,
    danaBez: bez.length,
    prosekSa: Number(prosek(sa).toFixed(2)),
    prosekBez: Number(prosek(bez).toFixed(2)),
    razlika: Number(razlika.toFixed(2)),
  };
}

/**
 * Glavni izveštaj. `dana` je koliko dana unazad gledamo (default 30).
 */
export async function izracunaj({ dana = 30, datum = danasISO() } = {}) {
  if (!featureEnabled.checklist) {
    throw new Error('Dnevna checklista nije podešena — nema iz čega da računam uvide.');
  }

  const do_ = datum;
  const od = pomeriDatum(datum, -(dana - 1));

  const checklista = await ucitajChecklistu(od, do_);
  const dnevnik = await ucitajDnevnik(od, do_);
  return sracunaj({ checklista, dnevnik, od, do: do_ });
}

/**
 * Čista računica nad već učitanim podacima — bez ijednog mrežnog poziva.
 * Odvojeno od dohvatanja da bi moglo da se testira nezavisno.
 */
export function sracunaj({ checklista, dnevnik = [], od, do: do_ }) {
  if (checklista.length === 0) {
    return { od, do: do_, brojDana: 0, poruka: 'Nema nijednog popunjenog dana u tom periodu.' };
  }

  const maks = SVE_STAVKE.length;
  const prosek = checklista.reduce((s, d) => s + d.skor, 0) / checklista.length;

  // Koje stavke se najčešće preskaču.
  const preskoceno = SVE_STAVKE.map((s) => ({
    stavka: s,
    propusteno: checklista.filter((d) => !d.stavke[s]).length,
    udeo: Math.round((checklista.filter((d) => !d.stavke[s]).length / checklista.length) * 100),
  }))
    .sort((a, b) => b.propusteno - a.propusteno)
    .slice(0, 5);

  // Prosek po danu u nedelji.
  const poDanu = {};
  for (const d of checklista) {
    const ime = imeDana(d.datum);
    (poDanu[ime] ??= []).push(d.skor);
  }
  const daniNedelje = Object.entries(poDanu)
    .map(([ime, skorovi]) => ({
      dan: ime,
      prosek: Number((skorovi.reduce((s, x) => s + x, 0) / skorovi.length).toFixed(1)),
      merenja: skorovi.length,
    }))
    .sort((a, b) => b.prosek - a.prosek);

  // Veze sa dnevnikom.
  const poDatumu = new Map(dnevnik.map((z) => [z.datum, z]));

  const zaRaspolozenje = checklista
    .map((d) => ({ ...d, ocena: poDatumu.get(d.datum)?.raspolozenje }))
    .filter((d) => d.ocena);
  const zaEnergiju = checklista
    .map((d) => ({ ...d, ocena: poDatumu.get(d.datum)?.energija }))
    .filter((d) => d.ocena);

  const vezeRaspolozenje = SVE_STAVKE.map((s) => veza(zaRaspolozenje, OCENE_RASPOLOZENJA, s))
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.razlika) - Math.abs(a.razlika))
    .slice(0, 3);

  const vezeEnergija = SVE_STAVKE.map((s) => veza(zaEnergiju, OCENE_ENERGIJE, s))
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.razlika) - Math.abs(a.razlika))
    .slice(0, 3);

  const rezultat = {
    od,
    do: do_,
    brojDana: checklista.length,
    prosekSkora: Number(prosek.toFixed(1)),
    maksSkor: maks,
    prosekProcenat: Math.round((prosek / maks) * 100),
    najboljiDan: checklista.slice().sort((a, b) => b.skor - a.skor)[0] ?? null,
    nizovi: nizovi(checklista, Math.ceil(maks * 0.7)),
    najcescePreskoceno: preskoceno,
    poDanimaNedelje: daniNedelje,
    vezaSaRaspolozenjem: vezeRaspolozenje,
    vezaSaEnergijom: vezeEnergija,
    napomena:
      dnevnik.length < 6
        ? 'Malo popunjenih dnevnika — veze sa raspoloženjem/energijom su nepouzdane ili ih nema.'
        : null,
  };

  logger.info(
    `Uvidi ${od}..${do_}: ${rezultat.brojDana} dana, prosek ${rezultat.prosekSkora}/${maks}.`,
  );
  return rezultat;
}
