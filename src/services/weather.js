import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Vremenska prognoza preko Open-Meteo API-ja (besplatan, bez ključa).
 *
 * Lokacija (geo koordinate + ime) dolazi iz config-a; podrazumevano Beograd.
 * Koristi se u jutarnjem pregledu i kao alat na zahtev ("kakvo je vreme").
 */

// WMO weather codes → srpski opis + emoji. https://open-meteo.com/en/docs
const WMO = {
  0: ['vedro', '☀️'],
  1: ['pretežno vedro', '🌤️'],
  2: ['promenljivo oblačno', '⛅'],
  3: ['oblačno', '☁️'],
  45: ['magla', '🌫️'],
  48: ['ledena magla', '🌫️'],
  51: ['slaba rosulja', '🌦️'],
  53: ['rosulja', '🌦️'],
  55: ['jaka rosulja', '🌧️'],
  61: ['slaba kiša', '🌦️'],
  63: ['kiša', '🌧️'],
  65: ['jaka kiša', '🌧️'],
  66: ['ledena kiša', '🌧️'],
  67: ['jaka ledena kiša', '🌧️'],
  71: ['slab sneg', '🌨️'],
  73: ['sneg', '🌨️'],
  75: ['jak sneg', '❄️'],
  77: ['susnežica', '🌨️'],
  80: ['pljuskovi', '🌦️'],
  81: ['jaki pljuskovi', '🌧️'],
  82: ['veoma jaki pljuskovi', '⛈️'],
  85: ['snežni pljuskovi', '🌨️'],
  86: ['jaki snežni pljuskovi', '❄️'],
  95: ['grmljavina', '⛈️'],
  96: ['grmljavina sa gradom', '⛈️'],
  99: ['jaka grmljavina sa gradom', '⛈️'],
};

function describe(code) {
  return WMO[code] || ['nepoznato', '🌡️'];
}

/**
 * Vraća današnju prognozu za konfigurisanu lokaciju.
 *
 * @returns {{location, now: number, code: number, description, emoji,
 *   max: number, min: number, precipitationChance: number, wind: number}}
 */
export async function getForecast() {
  const { latitude, longitude, locationName } = config.weather;
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${latitude}&longitude=${longitude}` +
    '&current=temperature_2m,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    `&timezone=${encodeURIComponent(config.timezone)}&forecast_days=1`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo greška: HTTP ${res.status}`);
  }
  const data = await res.json();

  const code = data.daily?.weather_code?.[0] ?? data.current?.weather_code ?? 0;
  const [description, emoji] = describe(code);

  return {
    location: locationName,
    now: Math.round(data.current?.temperature_2m ?? 0),
    code,
    description,
    emoji,
    max: Math.round(data.daily?.temperature_2m_max?.[0] ?? 0),
    min: Math.round(data.daily?.temperature_2m_min?.[0] ?? 0),
    precipitationChance: data.daily?.precipitation_probability_max?.[0] ?? 0,
    wind: Math.round(data.current?.wind_speed_10m ?? 0),
  };
}

/**
 * Kratak, čitljiv opis prognoze za jednu liniju u poruci.
 */
export async function getForecastLine() {
  try {
    const f = await getForecast();
    const rain = f.precipitationChance >= 30 ? `, padavine ${f.precipitationChance}%` : '';
    return (
      `${f.emoji} ${f.location}: ${f.description}, ${f.now}°C ` +
      `(danas ${f.min}–${f.max}°C, vetar ${f.wind} km/h${rain})`
    );
  } catch (err) {
    logger.error('Greška pri dohvatanju prognoze:', err);
    return null;
  }
}
