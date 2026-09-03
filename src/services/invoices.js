import { randomUUID } from 'node:crypto';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import * as notion from './notion.js';
import { uploadFile } from './drive.js';
import { generisiFakturu, ukupanIznos, formatirajIznos, formatirajDatum } from './invoice.js';

/**
 * Tok izrade fakture: prikupi podatke → nacrtaj PDF → pokaži vlasniku →
 * tek na potvrdu snimi na Drive i upiši u Notion arhivu.
 *
 * Faktura je finansijski dokument, pa se ne arhivira dok je čovek ne vidi.
 * Broj se rezerviše tek pri potvrdi — da odustanak ne napravi rupu u nizu.
 */

const cekaju = new Map();
const ROK_MS = 60 * 60 * 1000; // predlog važi sat vremena

function ocisti() {
  const sada = Date.now();
  for (const [id, s] of cekaju) {
    if (sada - s.napravljeno > ROK_MS) {
      cekaju.delete(id);
      logger.info(`Fakture: predlog ${id} istekao.`);
    }
  }
}

/** Datum "danas" u konfigurisanoj vremenskoj zoni, kao YYYY-MM-DD. */
function danas() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone }).format(new Date());
}

/**
 * Priprema fakturu i vraća PDF + sažetak, BEZ snimanja igde.
 *
 * @param {object} ulaz
 * @param {string} ulaz.klijent          deo naziva klijenta (traži se u Notion-u)
 * @param {Array}  ulaz.stavke           [{opis, kolicina?, cena}]
 * @param {string} [ulaz.datumIzdavanja] ISO; podrazumevano danas
 * @param {string} [ulaz.datumPrometa]   ISO; podrazumevano isto kao izdavanje
 * @param {string} [ulaz.mesto]          podrazumevano grad izdavaoca
 */
export async function pripremiFakturu(ulaz) {
  if (!featureEnabled.invoices) {
    throw new Error(
      'Fakture nisu podešene (trebaju NOTION_CLIENTS_DB_ID, NOTION_INVOICES_DB_ID i Google OAuth).',
    );
  }

  const { klijent, stavke } = ulaz;
  if (!klijent) throw new Error('Nedostaje klijent.');
  if (!Array.isArray(stavke) || stavke.length === 0) {
    throw new Error('Nedostaju stavke fakture (opis i cena).');
  }
  for (const s of stavke) {
    if (!s.opis || s.cena === undefined || s.cena === null || Number.isNaN(Number(s.cena))) {
      throw new Error('Svaka stavka mora imati opis i brojčanu cenu.');
    }
  }

  // Klijent iz Notion-a — ne dozvoljavamo da se fiskalni podaci izmišljaju.
  const pogodci = await notion.findClient({ query: klijent });
  if (pogodci.length === 0) {
    throw new Error(
      `Ne nalazim klijenta "${klijent}" u KLIJENTI bazi. Proveri naziv ili ga prvo dodaj.`,
    );
  }
  if (pogodci.length > 1) {
    throw new Error(
      `Naziv "${klijent}" odgovara većem broju klijenata: ${pogodci
        .map((k) => k.klijent)
        .join(', ')}. Budi precizniji.`,
    );
  }

  const k = pogodci[0];
  const fali = ['adresa', 'grad', 'pib', 'mb'].filter((p) => !k[p]);

  const datumIzdavanja = ulaz.datumIzdavanja || danas();
  const datumPrometa = ulaz.datumPrometa || datumIzdavanja;
  const mesto = ulaz.mesto || config.invoice.issuer.city;
  const broj = await notion.nextInvoiceNumber(Number(datumIzdavanja.slice(0, 4)));

  const pdf = await generisiFakturu({
    broj,
    klijent: { naziv: k.naziv, adresa: k.adresa, grad: k.grad, pib: k.pib, mb: k.mb },
    datumIzdavanja,
    datumPrometa,
    mesto,
    stavke,
  });

  const iznos = ukupanIznos(stavke);
  const id = randomUUID().slice(0, 8);

  ocisti();
  cekaju.set(id, {
    napravljeno: Date.now(),
    pdf,
    podaci: { broj, klijent: k, datumIzdavanja, datumPrometa, mesto, stavke, iznos },
  });

  logger.info(`Faktura ${broj} za ${k.klijent} pripremljena (${iznos} RSD) — čeka potvrdu.`);
  return { id, broj, iznos, klijent: k, fali, pdf, datumIzdavanja, datumPrometa, mesto, stavke };
}

/** Pripremljena faktura za prikaz (bez skidanja iz čekaonice). */
export function pogledaj(id) {
  ocisti();
  return cekaju.get(id) ?? null;
}

/**
 * Potvrda: snima PDF na Drive i upisuje red u Notion arhivu.
 *
 * Broj se ovde proverava PONOVO — ako je u međuvremenu izdata druga faktura
 * (npr. dva predloga otvorena istovremeno), uzima se sledeći slobodan da se
 * dva dokumenta ne nađu pod istim brojem.
 */
export async function potvrdiFakturu(id) {
  ocisti();
  const stavka = cekaju.get(id);
  if (!stavka) return null;
  cekaju.delete(id); // skidamo odmah — dupli klik ne sme da arhivira dvaput

  const p = stavka.podaci;
  let broj = p.broj;
  let pdf = stavka.pdf;

  const aktuelni = await notion.nextInvoiceNumber(Number(p.datumIzdavanja.slice(0, 4)));
  if (aktuelni !== broj) {
    logger.warn(`Faktura: broj ${broj} je u međuvremenu zauzet — prelazim na ${aktuelni}.`);
    broj = aktuelni;
    pdf = await generisiFakturu({
      broj,
      klijent: {
        naziv: p.klijent.naziv,
        adresa: p.klijent.adresa,
        grad: p.klijent.grad,
        pib: p.klijent.pib,
        mb: p.klijent.mb,
      },
      datumIzdavanja: p.datumIzdavanja,
      datumPrometa: p.datumPrometa,
      mesto: p.mesto,
      stavke: p.stavke,
    });
  }

  const imeFajla = `Racun ${broj} - ${p.klijent.klijent}.pdf`;
  const fajl = await uploadFile({
    name: imeFajla,
    buffer: pdf,
    mimeType: 'application/pdf',
    folderId: config.invoice.driveFolderId,
  });

  const zapis = await notion.addInvoice({
    broj,
    clientPageId: p.klijent.id,
    datumIzdavanja: p.datumIzdavanja,
    datumPrometa: p.datumPrometa,
    iznos: p.iznos,
    stavke: p.stavke.map((s) => s.opis).join('; '),
    mesto: p.mesto,
    pdfUrl: fajl.link,
  });

  logger.info(`Faktura ${broj} arhivirana: Drive ${fajl.id}, Notion ${zapis.id}`);
  return { broj, iznos: p.iznos, klijent: p.klijent.klijent, drive: fajl, notion: zapis };
}

/** Odustajanje — broj ostaje slobodan za sledeću fakturu. */
export function odbaci(id) {
  return cekaju.delete(id);
}

/** Koliko predloga čeka potvrdu (za /status). */
export function broj() {
  ocisti();
  return cekaju.size;
}

/** Sažetak za poruku uz PDF u Telegramu. */
export function opisiFakturu(f) {
  const redovi = f.stavke.map(
    (s) =>
      `• ${s.opis} — ${s.kolicina ?? 1} × ${formatirajIznos(s.cena)} = ` +
      `${formatirajIznos((s.kolicina ?? 1) * s.cena)}`,
  );

  const upozorenje = f.fali.length
    ? `\n\n⚠️ Klijentu fale podaci u Notion-u: ${f.fali.join(', ')}. ` +
      'Dopuni KLIJENTI bazu pa napravi ponovo, ili potvrdi ovakvu.'
    : '';

  return (
    `🧾 Faktura ${f.broj}\n\n` +
    `Klijent: ${f.klijent.naziv}\n` +
    `Datum izdavanja: ${formatirajDatum(f.datumIzdavanja)}\n` +
    `Datum prometa: ${formatirajDatum(f.datumPrometa)}\n\n` +
    `${redovi.join('\n')}\n\n` +
    `Ukupno: ${formatirajIznos(f.iznos)} RSD${upozorenje}\n\n` +
    'Pogledaj PDF pa potvrdi da ga snimim na Drive i upišem u arhivu.'
  );
}
