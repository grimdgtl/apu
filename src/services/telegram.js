import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runAgent } from './claude.js';

/**
 * Telegram servis — sloj između korisnika i Claude agenta.
 *
 * - Sluša tekstualne poruke.
 * - Odgovara samo vlasniku (TELEGRAM_OWNER_CHAT_ID) — lični asistent.
 * - Čuva kratku istoriju razgovora po chat-u (u memoriji).
 * - Izlaže `sendMessage` da scheduler može proaktivno da šalje poruke.
 */

export const bot = new Telegraf(config.telegram.token);

// Istorija razgovora po chatId. U produkciji zameni trajnom bazom po želji.
const histories = new Map();
const MAX_HISTORY = 20; // poslednjih N poruka (korisnik+asistent)

function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

function trimHistory(history) {
  // Zadrži poslednjih MAX_HISTORY, ali nikad ne počinji sa tool_result porukom.
  while (history.length > MAX_HISTORY) history.shift();
  while (
    history.length &&
    history[0].role === 'user' &&
    Array.isArray(history[0].content) &&
    history[0].content[0]?.type === 'tool_result'
  ) {
    history.shift();
  }
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
  histories.delete(ctx.chat.id);
  ctx.reply('Istorija razgovora je obrisana. 🧹');
});

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isOwner(chatId)) {
    logger.warn(`Ignorišem poruku od ne-vlasnika (chatId ${chatId}).`);
    return;
  }

  const userText = ctx.message.text;
  logger.info(`Poruka od vlasnika: ${userText}`);

  const history = getHistory(chatId);
  history.push({ role: 'user', content: userText });

  // "kuca..." indikator dok Claude radi.
  const typing = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
  ctx.sendChatAction('typing').catch(() => {});

  try {
    const { text, messages } = await runAgent(history);
    // Sačuvaj kompletnu istoriju (uključujući tool pozive) za kontekst.
    histories.set(chatId, messages);
    trimHistory(histories.get(chatId));
    await replyChunked(ctx, text);
  } catch (err) {
    logger.error('Greška pri obradi poruke:', err);
    await ctx.reply('Ups, došlo je do greške pri obradi zahteva. Pokušaj ponovo.');
  } finally {
    clearInterval(typing);
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
