import Anthropic from '@anthropic-ai/sdk';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { getEnabledTools } from '../tools/definitions.js';
import { executeTool } from '../tools/index.js';

/**
 * Claude servis — srce asistenta.
 *
 * `runAgent` vodi agentski petlju (agentic loop):
 *   1. Pošalje razgovor + definicije alata modelu.
 *   2. Ako model traži poziv alata (stop_reason === 'tool_use'), izvršimo alate
 *      i vratimo rezultate modelu.
 *   3. Ponavljamo dok model ne da finalni tekstualni odgovor.
 */

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

function systemPrompt() {
  const now = new Date();
  return [
    'Ti si lični AI asistent svog korisnika, integrisan u Telegram.',
    'Uvek odgovaraš na srpskom jeziku, prirodno i konkretno, bez suvišnog uvoda.',
    '',
    'Imaš pristup alatima za Notion (fakture i održavanje), Google Calendar ',
    '(pregled, slobodni termini, zakazivanje) i email (čitanje nepročitanih, ',
    'draftovi, slanje). Koristi alate kad su potrebni; ne izmišljaj podatke.',
    '',
    'Pravila:',
    '- Pre slanja mejla (mail_send) obavezno prvo predoči korisniku sadržaj i ',
    '  sačekaj izričitu potvrdu. Za nacrt koristi mail_save_draft.',
    '- Pre zakazivanja sastanka proveri slobodne termine ako je potrebno.',
    '- Kada rukuješ datumima, koristi ISO 8601 format i uzmi u obzir vremensku zonu.',
    '',
    `Trenutno vreme: ${now.toISOString()} (vremenska zona: ${config.timezone}).`,
  ].join('\n');
}

/**
 * @param {Array} messages  Anthropic-format poruke [{role, content}]
 * @param {object} [opts]
 * @param {number} [opts.maxSteps] koliko puta najviše da izvrši alate (default 8)
 * @returns {Promise<{text: string, messages: Array}>}
 *   text — finalni odgovor; messages — ažurirana istorija (sa tool pozivima).
 */
export async function runAgent(messages, { maxSteps = 8 } = {}) {
  const tools = getEnabledTools(featureEnabled);
  const working = [...messages];

  for (let step = 0; step < maxSteps; step++) {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: systemPrompt(),
      tools,
      messages: working,
    });

    // Dodaj odgovor asistenta u istoriju.
    working.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { text: text || '(prazan odgovor)', messages: working };
    }

    // Izvrši sve tražene alate i vrati rezultate.
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const call of toolUses) {
      const outcome = await executeTool(call.name, call.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(outcome),
        is_error: outcome.ok === false,
      });
    }
    working.push({ role: 'user', content: toolResults });
  }

  logger.warn(`runAgent: dostignut maxSteps (${maxSteps}) bez finalnog odgovora.`);
  return {
    text: 'Izvinjavam se, zahtev je previše kompleksan — pokušaj da ga podeliš na manje korake.',
    messages: working,
  };
}

/**
 * Jednokratni "one-shot" poziv bez alata — koristi ga scheduler za generisanje
 * teksta podsetnika iz sirovih podataka.
 */
export async function generateText(prompt, { system } = {}) {
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: system || systemPrompt(),
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
