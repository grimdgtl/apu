import { config } from '../config.js';
import { logger } from '../logger.js';
import * as notion from './notion.js';

/**
 * Monitor sajtova — proverava da li su sajtovi klijenata živi i dovoljno brzi.
 *
 * Lista sajtova se čita iz Notion KLIJENTI baze (samo status "Aktivan"), pa se
 * svaki domen "pinguje" HTTP GET zahtevom. Sajt se smatra ispravnim ako vrati
 * status < 400 i odgovori u okviru praga (config.monitor.slowMs). Sve preko
 * praga je "sporo", a mrežna greška ili status >= 400 znači "pao".
 */

/** Normalizuje domen u pun URL (dodaje https:// ako fali). */
function normalizeUrl(raw) {
  const url = String(raw).trim();
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

/**
 * Proverava jedan sajt. Nikad ne baca — vraća opisni rezultat.
 *
 * @returns {{name, url, ok, slow, status, ms, error}}
 */
async function checkSite(site) {
  const url = normalizeUrl(site.url);
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
