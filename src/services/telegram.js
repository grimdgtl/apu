import { Telegraf } from 'telegraf';
import { config, featureEnabled } from '../config.js';
import { logger } from '../logger.js';
import { runAgent } from './claude.js';
import { loadHistories, saveHistories } from '../store.js';
import { transcribe } from './transcribe.js';
import * as jobs from './jobs.js';

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
 * Da li je poruka POČETAK prave korisničke razmene (tekst ili slika koju je
 * poslao korisnik), a ne tool_result koji vraćamo modelu usred obrade.
 * tool_result poruke imaju array sadržaj čiji su elementi type "tool_result".
 */
function isUserTurn(m) {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  if (Array.isArray(m.content)) {
    return !m.content.some((b) => b?.type === 'tool_result');
  }
  return false;
}

/**
 * Skraćuje istoriju BEZ kidanja tool_use/tool_result parova.
 *
 * Seče isključivo na granici prave korisničke poruke (tekst/slika, ne
 * tool_result), pa istorija uvek počinje čistom razmenom i svaki tool poziv
 * zadržava svoj rezultat. Stara verzija je slepo bacala poruke s početka i
 * umela da ostavi tool_use bez para — što ruši kontekst (i API poziv).
 */
function trimHistory(history) {
  const turnStarts = [];
  for (let i = 0; i < history.length; i++) {
    if (isUserTurn(history[i])) turnStarts.push(i);
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

// /status — brz pregled uključenih integracija, bez gledanja u logove servera.
// Za isključene navodi koji env var fali, pa se odmah vidi šta treba dopuniti.
bot.command('status', (ctx) => {
  if (!isOwner(ctx.chat.id)) return;

  const rows = [
    ['Notion zadaci', featureEnabled.notionTasks, 'NOTION_API_KEY + NOTION_TASKS_DB_ID'],
    ['Notion Knowledge Base', featureEnabled.notionKb, 'NOTION_API_KEY + NOTION_KB_PAGE_ID'],
    ['Google Calendar', featureEnabled.calendar, 'GOOGLE_CLIENT_ID/SECRET + REFRESH_TOKEN'],
    ['Google Drive', featureEnabled.drive, 'GOOGLE_CLIENT_ID/SECRET + REFRESH_TOKEN'],
    ['Email', featureEnabled.mail, 'IMAP_USER + IMAP_PASSWORD'],
    ['Glasovne poruke', featureEnabled.voice, 'OPENAI_API_KEY ili GROQ_API_KEY'],
    ['Monitoring sajtova', featureEnabled.siteMonitor, 'NOTION_API_KEY + NOTION_CLIENTS_DB_ID'],
    ['Vremenska prognoza', featureEnabled.weather, ''],
    ['Izveštaji (Google Doc)', featureEnabled.reports, 'GOOGLE_CLIENT_ID/SECRET + REFRESH_TOKEN'],
  ];

  const lines = rows.map(([name, on, missing]) =>
    on ? `✅ ${name}` : `❌ ${name} — fali: ${missing}`,
  );

  const extra = [`\nModel: ${config.anthropic.model}`];
  if (featureEnabled.siteMonitor) {
    extra.push(
      `Provere sajtova: tiho "${config.cron.siteCheckSilent}", izveštaj "${config.cron.siteCheckReport}"`,
    );
  }

  ctx.reply(`Stanje integracija:\n\n${lines.join('\n')}\n${extra.join('\n')}`);
});

/**
 * Zajednička obrada — prosleđuje sadržaj (tekst, transkript ili sliku) Claude
 * agentu. `userContent` je string (tekst) ili niz content blokova (npr. slika).
 */
async function respondTo(ctx, chatId, userContent) {
  // Ne diramo sačuvano stanje dok poziv ne uspe — radimo nad kopijom.
  const history = [...getHistory(chatId), { role: 'user', content: userContent }];

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

bot.command('poslovi', async (ctx) => {
  if (!isOwner(ctx.chat.id)) return;
  const sati = Number(ctx.message.text.split(' ')[1]) || 24;
  await ctx.reply(`🔧 ${jobs.formatiraj(jobs.pregled({ sati }))}`);
});

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

// Podrazumevani nalog kada slika stigne bez opisa.
const DEFAULT_IMAGE_PROMPT =
  'Pogledaj ovu sliku i ukratko opiši šta je na njoj. Ako je račun, faktura ili ' +
  'dokument, izdvoj ključne podatke (iznos, datum, firmu, stavke) u pregledan spisak.';

// Anthropic preporučuje slike do ~5 MB.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Tipovi slika koje Claude vision podržava.
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Preuzima sliku sa Telegrama i šalje je Claude-u (vision) kao content blok,
 * uz opis (caption) ili podrazumevani nalog. Radi za slike poslate kao "photo"
 * (kompresovane) i kao "document" sa image/* tipom.
 */
async function handleImage(ctx, chatId, { fileId, mediaType = 'image/jpeg', caption }) {
  ctx.sendChatAction('typing').catch(() => {});
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const bytes = Buffer.from(await (await fetch(link.href)).arrayBuffer());

    if (bytes.length > MAX_IMAGE_BYTES) {
      await ctx.reply('Slika je prevelika (max ~5 MB). Pošalji je kompresovanu ili manju.');
      return;
    }

    const content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') },
      },
      { type: 'text', text: caption?.trim() || DEFAULT_IMAGE_PROMPT },
    ];

    logger.info(`Slika od vlasnika (${mediaType}, ${bytes.length} B)${caption ? ` — "${caption}"` : ''}`);
    await respondTo(ctx, chatId, content);
  } catch (err) {
    logger.error('Greška pri obradi slike:', err);
    await ctx.reply('Nisam uspeo da obradim sliku. Pokušaj ponovo.');
  }
}

// Fotografije (kompresovane) — biramo najveću veličinu.
bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isOwner(chatId)) return;
  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  await handleImage(ctx, chatId, {
    fileId: largest.file_id,
    mediaType: 'image/jpeg',
    caption: ctx.message.caption,
  });
});

// Slike poslate kao fajl (nekompresovane) — samo image/* tipovi.
bot.on('document', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isOwner(chatId)) return;
  const doc = ctx.message.document;
  const mt = doc.mime_type || '';
  if (!mt.startsWith('image/')) {
    await ctx.reply('Za sada umem da čitam samo slike (foto). Ovaj tip fajla još ne obrađujem.');
    return;
  }
  if (!SUPPORTED_IMAGE_TYPES.has(mt)) {
    await ctx.reply(
      `Format ${mt} nije podržan. Pošalji sliku kao JPEG, PNG, GIF ili WebP ` +
        '(ili je jednostavno pošalji kao foto).',
    );
    return;
  }
  await handleImage(ctx, chatId, {
    fileId: doc.file_id,
    mediaType: mt,
    caption: ctx.message.caption,
  });
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
