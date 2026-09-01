import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Crtanje fakture u PDF (pdfkit).
 *
 * Raspored prati postojeći obrazac:
 *   "Račun" + broj gore levo, logo gore desno, linija
 *   izdavalac levo / klijent desno (poravnat udesno)
 *   centrirano "Račun: NNN-GGGG"
 *   datumi i mesta izdavanja/prometa
 *   tabela stavki, pa "Ukupno RSD" desno
 *   podnožje: komentar i napomena o PDV-u levo, odgovorno lice desno
 *
 * Namerno bez Chromium-a/HTML-a: pdfkit je ~1 MB i radi u istom kontejneru,
 * dok bi headless browser utrostručio image radi istog lista papira.
 */

const KORENI = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FONTOVI = path.join(KORENI, '..', 'assets', 'fonts');
// Logo je lični/brendirani fajl pa NIJE u repozitorijumu (vidi
// assets/logo.example.png za očekivane proporcije). Putanju zadaj preko
// INVOICE_LOGO_PATH — najzgodnije u DATA_DIR volumen, koji ionako preživljava
// redeploy. Ako fajla nema, umesto slike se ispisuje naziv brenda iz .env.
const LOGO = config.invoice.logoPath || path.join(KORENI, '..', 'assets', 'logo.png');

// A4 sa marginama kao na obrascu.
const MARGINA = 50;
const SIRINA = 595.28; // A4 širina u tačkama
const DESNA_IVICA = SIRINA - MARGINA;
const SADRZAJ = DESNA_IVICA - MARGINA;

/** Iznos u srpskom formatu: 94000 → "94.000,00" */
export function formatirajIznos(broj) {
  return Number(broj).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** ISO datum → "17.6.2026." kako stoji na obrascu. */
export function formatirajDatum(iso) {
  const [g, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d}.${m}.${g}.`;
}

/**
 * Registruje rezove Montserrat-a.
 *
 * Namerno STATIČKI fajlovi, ne varijabilni Montserrat[wght].ttf: pdfkit pri
 * ugrađivanju subsetuje font, a fontkit na varijabilnom obliku pukne
 * ("First argument to DataView constructor must be an ArrayBuffer").
 */
const REZOVI = {
  regular: 'Montserrat-Regular.ttf',
  medium: 'Montserrat-Medium.ttf',
  semibold: 'Montserrat-SemiBold.ttf',
  bold: 'Montserrat-Bold.ttf',
};

function registrujFontove(doc) {
  for (const [ime, fajl] of Object.entries(REZOVI)) {
    const put = path.join(FONTOVI, fajl);
    if (!fs.existsSync(put)) {
      throw new Error(`Nedostaje font: ${put}`);
    }
    doc.registerFont(ime, put);
  }
}

/** Blok teksta, red po red, sa zadatim poravnanjem. */
function blok(doc, redovi, x, y, sirina, poravnanje = 'left', razmak = 14) {
  let trenutni = y;
  for (const red of redovi.filter(Boolean)) {
    doc.text(red, x, trenutni, { width: sirina, align: poravnanje });
    trenutni += razmak;
  }
  return trenutni;
}

/**
 * Generiše PDF fakture i vraća ga kao Buffer.
 *
 * @param {object} f
 * @param {string} f.broj              npr. "042-2026"
 * @param {object} f.klijent           {naziv, adresa, grad, pib, mb}
 * @param {string} f.datumIzdavanja    ISO
 * @param {string} f.datumPrometa      ISO
 * @param {string} [f.mesto]           mesto izdavanja/prometa
 * @param {Array}  f.stavke            [{opis, kolicina, cena}]
 * @returns {Promise<Buffer>}
 */
export function generisiFakturu(f) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: MARGINA });
      const delovi = [];
      doc.on('data', (d) => delovi.push(d));
      doc.on('end', () => resolve(Buffer.concat(delovi)));
      doc.on('error', reject);

      registrujFontove(doc);
      const izd = config.invoice.issuer;
      const mesto = f.mesto || izd.city;

      // ---------------------------------------------------------- zaglavlje ---
      doc.font('regular').fontSize(34).fillColor('#000');
      doc.text('Račun', MARGINA, MARGINA);
      doc.fontSize(17).text(f.broj, MARGINA, MARGINA + 40);

      // Logo desno; ako ga nema, ispiši naziv firme da list ne ostane prazan.
      if (fs.existsSync(LOGO)) {
        const visina = 42;
        doc.image(LOGO, DESNA_IVICA - 170, MARGINA + 4, {
          fit: [170, visina],
          align: 'right',
          valign: 'top',
        });
      } else {
        doc
          .font('semibold')
          .fontSize(20)
          .text(izd.brand || izd.name, DESNA_IVICA - 220, MARGINA + 12, {
            width: 220,
            align: 'right',
          });
      }

      let y = MARGINA + 78;
      doc.moveTo(MARGINA, y).lineTo(DESNA_IVICA, y).lineWidth(1).strokeColor('#000').stroke();

      // -------------------------------------------- izdavalac / primalac ---
      y += 14;
      doc.font('regular').fontSize(9.5).fillColor('#000');

      blok(
        doc,
        [
          izd.name,
          `${izd.address}, ${izd.city}`,
          izd.phone,
          `PIB: ${izd.pib}`,
          `MB: ${izd.mb}`,
          `Broj računa: ${izd.bankAccount}`,
          izd.bankName,
        ],
        MARGINA,
        y,
        260,
        'left',
      );

      blok(
        doc,
        [
          f.klijent.naziv,
          f.klijent.adresa,
          f.klijent.grad,
          f.klijent.pib ? `PIB: ${f.klijent.pib}` : null,
          f.klijent.mb ? `MB: ${f.klijent.mb}` : null,
        ],
        DESNA_IVICA - 260,
        y,
        260,
        'right',
      );

      // ------------------------------------------------ broj računa (centar) ---
      y += 122;
      doc.font('bold').fontSize(11);
      doc.text(`Račun: ${f.broj}`, MARGINA, y, { width: SADRZAJ, align: 'center' });

      // ----------------------------------------------------------- datumi ---
      y += 44;
      doc.font('regular').fontSize(9.5);
      y = blok(
        doc,
        [
          `Datum izdavanja računa: ${formatirajDatum(f.datumIzdavanja)}`,
          `Mesto izdavanja: ${mesto}`,
          `Datum prometa usluge: ${formatirajDatum(f.datumPrometa)}`,
          `Mesto prometa usluge: ${mesto}.`,
        ],
        MARGINA,
        y,
        SADRZAJ,
        'left',
      );

      // ---------------------------------------------------------- tabela ---
      y += 26;
      const KOL = {
        opis: { x: MARGINA + 8, w: 235 },
        kolicina: { x: MARGINA + 250, w: 70 },
        cena: { x: MARGINA + 325, w: 90 },
        ukupno: { x: MARGINA + 420, w: 75 },
      };

      const vrhTabele = y;
      doc.font('regular').fontSize(9.5);
      doc.text('Usluga', KOL.opis.x, y + 8, { width: KOL.opis.w, align: 'center' });
      doc.text('Količina', KOL.kolicina.x, y + 8, { width: KOL.kolicina.w, align: 'center' });
      doc.text('Jedinična cena', KOL.cena.x, y + 8, { width: KOL.cena.w, align: 'center' });
      doc.text('Ukupna cena', KOL.ukupno.x, y + 8, { width: KOL.ukupno.w, align: 'center' });

      const linijaZaglavlja = y + 26;
      doc.moveTo(MARGINA, linijaZaglavlja).lineTo(DESNA_IVICA, linijaZaglavlja).stroke();

      // Redovi stavki — visina reda prati koliko je opis prelomljen.
      let redY = linijaZaglavlja + 10;
      let ukupno = 0;

      for (const s of f.stavke) {
        const kolicina = Number(s.kolicina ?? 1);
        const cena = Number(s.cena);
        const zbir = kolicina * cena;
        ukupno += zbir;

        const visinaOpisa = doc.heightOfString(s.opis, { width: KOL.opis.w });
        const visinaReda = Math.max(visinaOpisa, 14);
        // Brojevi se centriraju po visini u odnosu na (moguće višeredni) opis.
        const sredina = redY + Math.max(0, (visinaReda - 11) / 2);

        doc.text(s.opis, KOL.opis.x, redY, { width: KOL.opis.w });
        doc.text(String(kolicina), KOL.kolicina.x, sredina, {
          width: KOL.kolicina.w,
          align: 'center',
        });
        doc.text(formatirajIznos(cena), KOL.cena.x, sredina, {
          width: KOL.cena.w,
          align: 'center',
        });
        doc.text(formatirajIznos(zbir), KOL.ukupno.x, sredina, {
          width: KOL.ukupno.w,
          align: 'center',
        });

        redY += visinaReda + 12;
      }

      // Okvir tabele i vertikalne linije.
      const dnoTabele = redY;
      doc.rect(MARGINA, vrhTabele, SADRZAJ, dnoTabele - vrhTabele).stroke();

      // ---------------------------------------------------------- ukupno ---
      y = dnoTabele + 18;
      doc.font('regular').fontSize(13);
      doc.text(`Ukupno RSD: ${formatirajIznos(ukupno)}`, MARGINA, y, {
        width: SADRZAJ,
        align: 'right',
      });

      y += 34;
      doc.moveTo(MARGINA, y).lineTo(DESNA_IVICA, y).stroke();

      // --------------------------------------------------------- podnožje ---
      y += 30;
      doc.font('bold').fontSize(8.5).text('Komentar:', MARGINA, y);
      doc.font('regular').fontSize(9).text(config.invoice.comment, MARGINA, y + 13);

      y += 46;
      doc.font('bold').fontSize(8.5).text('Napomena o poreskom oslobođenju:', MARGINA, y);
      doc.font('regular').fontSize(9).text(config.invoice.vatNote, MARGINA, y + 13);

      // Odgovorno lice — desno, u ravni sa napomenom.
      doc
        .font('bold')
        .fontSize(8.5)
        .text('Odgovorno lice:', DESNA_IVICA - 200, y, { width: 200, align: 'right' });
      doc
        .font('regular')
        .fontSize(9)
        .text(izd.responsiblePerson, DESNA_IVICA - 200, y + 13, { width: 200, align: 'right' });

      doc.end();
      logger.info(`Faktura ${f.broj}: PDF nacrtan (${f.stavke.length} stavki, ${ukupno} RSD).`);
    } catch (err) {
      reject(err);
    }
  });
}

/** Zbir svih stavki — koristi ga i Notion upis, da se računa na jednom mestu. */
export function ukupanIznos(stavke) {
  return stavke.reduce((z, s) => z + Number(s.kolicina ?? 1) * Number(s.cena), 0);
}
