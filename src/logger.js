/**
 * Minimalni logger sa vremenskim pečatom i nivoom.
 */

function ts() {
  return new Date().toISOString();
}

/**
 * Skraćuje tekst za log. Ovo je lični asistent — kroz njega prolaze mejlovi,
 * lozinke koje korisnik izdiktira, zdravstvene beleške. Pun sadržaj u logu
 * (koji ide u Docker/Coolify i ostaje da stoji) nije potreban za dijagnostiku.
 */
export function skrati(value, max = 120) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} zn.)`;
}

// Polja koja nikad ne idu u log u celini — tela mejlova, beleške, sadržaj.
const OSETLJIVA = new Set(['body', 'content', 'tekst', 'text', 'sadrzaj', 'preview', 'password']);

/**
 * Priprema argumente alata za log: osetljiva polja zamenjuje dužinom,
 * ostalo skraćuje. Tako se u logu vidi ŠTA je pozvano, bez samog sadržaja.
 */
export function bezOsetljivog(input) {
  if (!input || typeof input !== 'object') return skrati(input, 200);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (OSETLJIVA.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' ? `<${v.length} zn.>` : '<sakriveno>';
    } else {
      out[k] = typeof v === 'string' ? skrati(v, 80) : v;
    }
  }
  return JSON.stringify(out);
}

export const logger = {
  info: (...args) => console.log(`[${ts()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${ts()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${ts()}] [ERROR]`, ...args),
  debug: (...args) => {
    if (process.env.DEBUG) console.log(`[${ts()}] [DEBUG]`, ...args);
  },
};
