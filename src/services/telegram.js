import { Telegraf } from 'telegraf';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { runAgent } from './claude.js';
import { loadHistories, saveHistories } from '../store.js';
import { transcribe } from './transcribe.js';

/**
 * Telegram servis — sloj između korisnika i Claude agenta.
 *
 * - Sluša tekstualne poruke.
 * - Odgovara samo vlasniku (TELEGRAM_OWNER_CHAT_ID) — lični asistent.
 * - Čuva kratku istoriju razgovora po chat-u (u memoriji).
 * - Izlaže `sendMessage` da scheduler može proaktivno da šalje poruke.
 */

export const bot = new Telegraf(config.telegram.token, {
  // Agentski tok (Claude + alati) sme da traje; ne sečemo ga na 90s.
  handlerTimeout: 300_000, // 5 min
});

// KLJUČNO: hvatamo sve greške obrade da NE sruše proces.
// Bez ovoga Telegraf rethrow-uje grešku, launch pukne, kontejner se restartuje
// i ista poruka se obrađuje iznova — beskonačna petlja (i duplo slanje mejla).
bot.catch((err, ctx) => {
  logger.error('Telegraf greška (uhvaćena, bot nastavlja):', err?.message || err);
  ctx?.reply?.('Ups, došlo je do greške pri obradi. Pokušaj ponovo.').catch(() => {});
});

// Istorija razgovora po chatId — učitana sa diska, pa preživi restart.
const histories = loadHistories();

// Broj PRAVIH razmena (tvojih tekstualnih poruka) koje pamtimo.
// Ne brojimo sirove poruke, jer jedan upit sa alatima napravi njih 4+.
const MAX_TURNS = 12;

function key(chatId) {
  return String(chatId);
}

function getHistory(chatId) {
  return histories.get(key(chatId)) ?? [];
}

/**
 * Skraćuje istoriju BEZ kidanja tool_use/tool_result parova.
 *
 * Seče isključivo na granici prave korisničke poruke (tekst, ne tool_result),
 * pa istorija uvek počinje čistom razmenom i svaki tool poziv zadržava svoj
 * rezultat. Stara verzija je slepo bacala poruke s početka i umela da ostavi
 * tool_use bez para — što ruši kontekst (i API poziv).
 */
function trimHistory(history) {
  const turnStarts = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'user' && typeof m.content === 'string') turnStarts.push(i);
  }
  if (turnStarts.length <= MAX_TURNS) return history;
  return history.slice(turnStarts[turnStarts.length - MAX_TURNS]);
}

function isOwner(chatId) {
  return String(chatId) === String(config.telegram.ownerChatId);
}

// /start i /reset komande
bot.start((ctx) => {
  if (!isOwner(ctx.chat.id)) return;
  ctx.reply('Zdravo! Ja sam tvoj lični asistent. Pitaj me bilo šta — kalendar, mejlovi, fakture...');
});

bot.command('reset', (ctx) => {
  if (!isOwner(ctx.chat.id)) return;
  histories.delete(key(ctx.chat.id));
  saveHistories(histories);
  ctx.reply('Istorija razgovora je obrisana. 🧹');
});

/**
 * Zajednička obrada — prosleđuje tekst (otkucan ili transkribovan) Claude agentu.
 */
async function respondTo(ctx, chatId, userText) {
  // Ne diramo sačuvano stanje dok poziv ne uspe — radimo nad kopijom.
  const history = [...getHistory(chatId), { role: 'user', content: userText }];

  // "kuca..." indikator dok Claude radi.
  const typing = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
  ctx.sendChatAction('typing').catch(() => {});

  try {
    const { text, messages } = await runAgent(history);
    // Sačuvaj kompletnu istoriju (uključujući tool pozive) za kontekst.
    histories.set(key(chatId), trimHistory(messages));
    saveHistories(histories);
    await replyChunked(ctx, text);
  } catch (err) {
    logger.error('Greška pri obradi poruke:', err);
    await ctx.reply('Ups, došlo je do greške pri obradi zahteva. Pokušaj ponovo.');
  } finally {
    clearInterval(typing);
  }
}

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isOwner(chatId)) {
    logger.warn(`Ignorišem poruku od ne-vlasnika (chatId ${chatId}).`);
    return;
  }
  const userText = ctx.message.text;
  logger.info(`Poruka od vlasnika: ${userText}`);
  await respondTo(ctx, chatId, userText);
});

// Glasovne poruke: skini OGG → transkribuj (Whisper) → isti tok kao tekst.
bot.on('voice', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isOwner(chatId)) return;

  if (!featureEnabled.voice) {
    await ctx.reply('Glasovne poruke još nisu podešene (nedostaje OPENAI_API_KEY ili GROQ_API_KEY).');
    return;
  }

  ctx.sendChatAction('typing').catch(() => {});
  try {
    const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const audio = Buffer.from(await (await fetch(link.href)).arrayBuffer());
    const text = await transcribe(audio);

    if (!text) {
      await ctx.reply('Nisam razumeo glasovnu poruku — pokušaj ponovo.');
      return;
    }

    // Pokaži šta je razumeo, pa obradi kao običnu poruku.
    await ctx.reply(`🎤 „${text}"`);
    await respondTo(ctx, chatId, text);
  } catch (err) {
    logger.error('Greška pri obradi glasovne:', err);
    await ctx.reply('Nisam uspeo da obradim glasovnu poruku. Pokušaj ponovo.');
  }
});

/**
 * Telegram ograničava poruke na 4096 karaktera — delimo duže poruke.
 */
async function replyChunked(ctx, text) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

/**
 * Proaktivno slanje poruke vlasniku (koristi scheduler).
 */
export async function sendMessage(text, chatId = config.telegram.ownerChatId) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await bot.telegram.sendMessage(chatId, text.slice(i, i + LIMIT));
  }
  logger.info('Proaktivna poruka poslata vlasniku.');
}
