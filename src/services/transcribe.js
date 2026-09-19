import { config } from '../config.js';
import { logger, skrati } from '../logger.js';
import { uLatinicu, imaCirilice } from './pismo.js';

/**
 * Govor u tekst preko Whisper-a.
 *
 * Provajder se bira automatski po prisutnom ključu:
 *   - GROQ_API_KEY   → Groq (whisper-large-v3), jeftino/brzo
 *   - OPENAI_API_KEY → OpenAI (whisper-1)
 *
 * Oba imaju isti (OpenAI-kompatibilan) multipart API, razlika je samo URL/model.
 */

function mimeFor(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  return (
    {
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      opus: 'audio/ogg',
      m4a: 'audio/mp4',
      mp4: 'audio/mp4',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      webm: 'audio/webm',
      flac: 'audio/flac',
    }[ext] || 'audio/ogg'
  );
}

function pickProvider() {
  if (config.transcription.groqKey) {
    return {
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      key: config.transcription.groqKey,
      model: 'whisper-large-v3',
    };
  }
  if (config.transcription.openaiKey) {
    return {
      url: 'https://api.openai.com/v1/audio/transcriptions',
      key: config.transcription.openaiKey,
      model: 'whisper-1',
    };
  }
  throw new Error('Transkripcija nije podešena (nedostaje OPENAI_API_KEY ili GROQ_API_KEY).');
}

/**
 * Transkribuje audio (Buffer) u tekst.
 * @param {Buffer} audioBuffer  sadržaj audio fajla (npr. Telegram OGG/Opus)
 * @param {string} [filename]   ime fajla — ekstenzija pomaže servisu da pogodi format
 * @returns {Promise<string>}
 */
export async function transcribe(audioBuffer, filename = 'voice.ogg') {
  const p = pickProvider();

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeFor(filename) }), filename);
  form.append('model', p.model);
  form.append('language', 'sr'); // nagoveštaj: srpski (kraće komande bolje pogađa)
  // Whisper srpski podrazumevano ispisuje ĆIRILICOM. `prompt` služi kao uzorak
  // stila — latinični tekst ga navede da i transkript bude latinica. Nije
  // garancija (zato posle ide preslovljavanje), ali smanjuje posao.
  form.append(
    'prompt',
    'Transkript je na srpskom jeziku, pisan latinicom. Primer: Ćao, šta ima? ' +
      'Đorđe je poslao mejl u vezi sa fakturom, treba da mu odgovorim danas.',
  );

  const res = await fetch(p.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.key}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Transkripcija greška ${res.status}: ${data?.error?.message || JSON.stringify(data)}`,
    );
  }

  const sirovo = (data.text || '').trim();

  // KLJUČNO: transkript ulazi u istoriju razgovora kao korisnikova poruka. Ako
  // ostane ćirilica, model je vidi u kontekstu i počne da odgovara ćirilicom —
  // a pošto se istorija čuva na disk, to se prenosi i na sve naredne razgovore.
  const text = uLatinicu(sirovo);
  if (imaCirilice(sirovo)) {
    logger.info('Transkript je stigao ćirilicom — preslovljen u latinicu.');
  }

  logger.info(`Transkribovana glasovna (${p.model}): "${skrati(text, 80)}"`);
  return text;
}
