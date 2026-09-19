/**
 * Ćirilica → latinica.
 *
 * Bot je uvek imao uputstvo "piši latinicom" u system promptu, ali uputstvo je
 * samo molba modelu — i curi na dva mesta:
 *
 *   1. Whisper transkribuje srpski u ĆIRILICU. Taj tekst ulazi u istoriju kao
 *      korisnikova poruka, model vidi ćirilicu u kontekstu i počne da je
 *      preslikava. Pošto se istorija čuva na disk, jedna glasovna poruka
 *      "zarazi" i sve naredne razgovore.
 *   2. Model i sam ume da odluta na dugom kontekstu.
 *
 * Zato se ovde pismo nameće deterministički — i na ulazu (transkript) i na
 * izlazu (sve što ide u Telegram). Uputstvo u promptu ostaje kao prva linija
 * odbrane, ovo je garancija.
 */

// Digrafi prvo — inače bi "љ" prošlo kroz mapu slovo po slovo.
const MAPA = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'đ', е: 'e', ж: 'ž', з: 'z',
  и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', ћ: 'ć', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'č', џ: 'dž', ш: 'š',
};

const VELIKA = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Ђ: 'Đ', Е: 'E', Ж: 'Ž', З: 'Z',
  И: 'I', Ј: 'J', К: 'K', Л: 'L', Љ: 'Lj', М: 'M', Н: 'N', Њ: 'Nj', О: 'O',
  П: 'P', Р: 'R', С: 'S', Т: 'T', Ћ: 'Ć', У: 'U', Ф: 'F', Х: 'H', Ц: 'C',
  Ч: 'Č', Џ: 'Dž', Ш: 'Š',
};

const CIRILICA = /[Ѐ-ӿ]/;

/** Da li je znak veliko ćirilično slovo (za "ЉУБАВ" → "LJUBAV", ne "LjUBAV"). */
function jeVeliko(znak) {
  return znak !== undefined && Object.prototype.hasOwnProperty.call(VELIKA, znak);
}

/**
 * Preslovi tekst iz srpske ćirilice u latinicu. Sve ostalo (latinica, brojevi,
 * emodži, URL-ovi) ostaje netaknuto.
 *
 * @param {string} text
 * @returns {string}
 */
export function uLatinicu(text) {
  if (typeof text !== 'string' || !CIRILICA.test(text)) return text;

  const znakovi = [...text];
  let rezultat = '';

  for (let i = 0; i < znakovi.length; i++) {
    const znak = znakovi[i];

    if (Object.prototype.hasOwnProperty.call(VELIKA, znak)) {
      const latinica = VELIKA[znak];
      // Digraf usred reči pisanog velikim slovima ide ceo velikim ("Њ" u
      // "ЊЕГОВ" je "NJ", a u "Његов" je "Nj").
      rezultat += latinica.length > 1 && jeVeliko(znakovi[i + 1])
        ? latinica.toUpperCase()
        : latinica;
      continue;
    }

    rezultat += MAPA[znak] ?? znak;
  }

  return rezultat;
}

/** Da li tekst uopšte sadrži ćirilicu — za logovanje da se drift primeti. */
export function imaCirilice(text) {
  return typeof text === 'string' && CIRILICA.test(text);
}
