import { config } from '../config.js';
import { logger } from '../logger.js';
import { zabelezi } from './monitorHistory.js';
import * as notion from './notion.js';

/**
 * Monitor sajtova — proverava da li su sajtovi klijenata živi i dovoljno brzi.
 *
 * Lista sajtova se čita iz Notion KLIJENTI baze (samo status "Aktivan"), pa se
 * svaki domen "pinguje" HTTP GET zahtevom. Sajt se smatra ispravnim ako vrati
 * status < 400 i odgovori u okviru praga (config.monitor.slowMs). Sve preko
 * praga je "sporo", a mrežna greška ili status >= 400 znači "pao".
 */

/**
 * Hostovi koji pokazuju na samu mašinu ili privatnu mrežu. Monitor je alat za
 * javne sajtove klijenata; ako se u koloni Domen slučajno (ili preko tuđe
 * izmene deljene baze) nađe interna adresa, provera bi postala skener
 * unutrašnje mreže i cloud metadata servisa.
 */
function jePrivatanHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (h === '169.254.169.254') return true; // cloud metadata
  if (/^127\./.test(h) || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

/**
 * Normalizuje domen u pun URL (dodaje https:// ako fali) i proverava da je
 * upotrebljiv. Baca ako shema nije http(s) ili host nije javan.
 */
function normalizeUrl(raw) {
  const text = String(raw).trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`nepodržana shema "${url.protocol}"`);
  }
  if (jePrivatanHost(url.hostname)) {
    throw new Error(`interna adresa "${url.hostname}" — preskačem`);
  }
  return url.toString();
}

/**
 * Proverava jedan sajt. Nikad ne baca — vraća opisni rezultat.
 *
 * @returns {{name, url, ok, slow, status, ms, error}}
 */
async function checkSite(site) {
  // Neispravan ili interni URL je greška TOG sajta, ne cele provere — inače
  // bi jedan pogrešan red u Notion-u oborio proveru svih ostalih.
  let url;
  try {
    url = normalizeUrl(site.url);
  } catch (err) {
    logger.warn(`Monitor: preskačem "${site.name}" — ${err.message}`);
    return {
      name: site.name,
      url: String(site.url),
      ok: false,
      slow: false,
      status: null,
      ms: 0,
      error: `neispravan URL (${err.message})`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.monitor.timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Neki serveri blokiraju zahteve bez "pravog" User-Agent-a.
        'User-Agent': 'APU-Monitor/1.0 (+https://grim-digital.com)',
      },
    });
    const ms = Date.now() - started;
    const down = res.status >= 400;
    const slow = !down && ms > config.monitor.slowMs;
    return {
      name: site.name,
      url,
      ok: !down && !slow,
      slow,
      status: res.status,
      ms,
      error: down ? `HTTP ${res.status}` : null,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const aborted = err?.name === 'AbortError';
    return {
      name: site.name,
      url,
      ok: false,
      slow: false,
      status: null,
      ms,
      error: aborted ? `timeout (>${config.monitor.timeoutMs} ms)` : err?.message || 'greška',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Proverava sve aktivne sajtove paralelno.
 *
 * @returns {{results: Array, problems: Array, checked: number}}
 */
export async function checkAllSites() {
  const sites = await notion.listActiveSites();
  logger.info(`Monitor: proveravam ${sites.length} aktivnih sajtova...`);

  const results = await Promise.all(sites.map(checkSite));
  const problems = results.filter((r) => !r.ok);

  // Zapamti rezultat da bismo kasnije mogli da izračunamo uptime.
  try {
    zabelezi(results);
  } catch (err) {
    logger.error('Ne mogu da upišem istoriju monitoringa:', err.message);
  }

  return { results, problems, checked: results.length };
}

/**
 * Formatira izveštaj za Telegram.
 *
 * @param {object} data - rezultat checkAllSites()
 * @param {boolean} full - true = pun izveštaj (sve OK), false = samo problemi
 */
export function formatReport({ results, problems, checked }, full) {
  if (checked === 0) {
    return '🌐 Monitoring: nema aktivnih sajtova sa domenom za proveru.';
  }

  const line = (r) => {
    if (r.ok) return `✅ ${r.name} — ${r.ms} ms`;
    if (r.slow) return `🐢 ${r.name} — sporo (${r.ms} ms)`;
    return `❌ ${r.name} — ${r.error}`;
  };

  if (!full) {
    // Tihi režim (10:00): javi samo ako ima problema.
    if (problems.length === 0) return null;
    const body = problems.map(line).join('\n');
    return `⚠️ Problem sa sajtovima (${problems.length}/${checked}):\n\n${body}`;
  }

  // Pun izveštaj (18:00): prikaži sve, problemi na vrhu.
  const sorted = [...results].sort((a, b) => Number(a.ok) - Number(b.ok));
  const body = sorted.map(line).join('\n');
  const header =
    problems.length === 0
      ? `🌐 Svih ${checked} sajtova radi normalno. ✅`
      : `🌐 Provera sajtova — ${problems.length}/${checked} sa problemom:`;
  return `${header}\n\n${body}`;
}
