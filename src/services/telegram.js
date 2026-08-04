import { Telegraf, Markup } from 'telegraf';
import { config, featureEnabled } from '../config.js';
import { logger, skrati } from '../logger.js';
import { runAgent } from './claude.js';
import { loadHistories, saveHistories } from '../store.js';
import { transcribe } from './transcribe.js';
import * as jobs from './jobs.js';
import * as outbox from './outbox.js';
import * as invoices from './invoices.js';
import { sendMail } from './mail.js';

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
    ['Rođendani', featureEnabled.birthdays, 'NOTION_API_KEY + NOTION_BIRTHDAYS_DB_ID'],
    ['Fakture', featureEnabled.invoices, 'NOTION_CLIENTS_DB_ID + NOTION_INVOICES_DB_ID + Google'],
    ['Vremenska prognoza', featureEnabled.weather, ''],
    ['Izveštaji (Google Doc)', featureEnabled.reports, 'GOOGLE_CLIENT_ID/SECRET + REFRESH_TOKEN'],
  ];

  const lines = rows.map(([name, on, missing]) =>
    on ? `✅ ${name}` : `❌ ${name} — fali: ${missing}`,
  );

  const extra = [`\nModel: ${config.anthropic.model}`];
  const cekaju = outbox.broj();
  if (cekaju > 0) extra.push(`Mejlova čeka potvrdu: ${cekaju}`);
  const fakture = invoices.broj();
  if (fakture > 0) extra.push(`Faktura čeka potvrdu: ${fakture}`);
  if (featureEnabled.siteMonitor) {
    extra.push(
      `Provere sajtova: tiho "${config.cron.siteCheckSilent}", izveštaj "${config.cron.siteCheckReport}"`,
    );
  }
  if (featureEnabled.birthdays) {
    extra.push(
      `Rođendani: najava "${config.cron.birthdayMorning}", podsetnik "${config.cron.birthdayEvening}"`,
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
  logger.info(`Poruka od vlasnika: ${skrati(userText)}`);
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

  // Veličinu proveravamo PRE skidanja — Telegram je šalje uz poruku, pa nema
  // razloga da prvo povučemo ceo fajl u memoriju da bismo ga onda odbili.
  const voice = ctx.message.voice;
  if (voice.file_size && voice.file_size > MAX_AUDIO_BYTES) {
    await ctx.reply('Glasovna poruka je preduga (max ~20 MB). Pošalji kraću.');
    return;
  }

  ctx.sendChatAction('typing').catch(() => {});
  try {
    const link = await ctx.telegram.getFileLink(voice.file_id);
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

// Telegram Bot API ionako ne daje da se skine fajl veći od 20 MB.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

// Tipovi slika koje Claude vision podržava.
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Preuzima sliku sa Telegrama i šalje je Claude-u (vision) kao content blok,
 * uz opis (caption) ili podrazumevani nalog. Radi za slike poslate kao "photo"
 * (kompresovane) i kao "document" sa image/* tipom.
 */
async function handleImage(ctx, chatId, { fileId, mediaType = 'image/jpeg', caption, fileSize }) {
  // Odbij po prijavljenoj veličini pre skidanja; posle skidanja proveravamo
  // još jednom, jer file_size ume da izostane.
  if (fileSize && fileSize > MAX_IMAGE_BYTES) {
    await ctx.reply('Slika je prevelika (max ~5 MB). Pošalji je kompresovanu ili manju.');
    return;
  }

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

    logger.info(
      `Slika od vlasnika (${mediaType}, ${bytes.length} B)` +
        (caption ? ` — "${skrati(caption, 80)}"` : ''),
    );
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
    fileSize: largest.file_size,
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
    fileSize: doc.file_size,
  });
});

// ------------------------------------------------- potvrda slanja mejla ---

/**
 * Pokazuje vlasniku pripremljen mejl i traži potvrdu dugmetom.
 * Zove je alat `mail_send` — model sam ne može da pošalje ništa.
 */
export async function zatraziPotvrduMaila(id, mail) {
  const telo = mail.body.length > 1500 ? `${mail.body.slice(0, 1500)}\n…(skraćeno)` : mail.body;
  const pregled =
    '📧 Treba da pošaljem ovaj mejl — potvrdi:\n\n' +
    `Za: ${mail.to}\n` +
    (mail.cc ? `Cc: ${mail.cc}\n` : '') +
    `Naslov: ${mail.subject}\n\n${telo}`;

  await bot.telegram.sendMessage(
    config.telegram.ownerChatId,
    pregled,
    Markup.inlineKeyboard([
      Markup.button.callback('✅ Pošalji', `mail:send:${id}`),
      Markup.button.callback('❌ Otkaži', `mail:cancel:${id}`),
    ]),
  );
}

// Pritisak na dugme — jedino mesto odakle mejl zaista odlazi.
bot.action(/^mail:(send|cancel):([a-f0-9-]+)$/i, async (ctx) => {
  if (!isOwner(ctx.chat?.id ?? ctx.from?.id)) {
    await ctx.answerCbQuery('Nemaš dozvolu.').catch(() => {});
    return;
  }

  const [, radnja, id] = ctx.match;

  if (radnja === 'cancel') {
    outbox.odbaci(id);
    await ctx.answerCbQuery('Otkazano.').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply('❌ Mejl nije poslat.');
    return;
  }

  // Skidamo iz čekaonice ODMAH — dupli klik ne sme da pošalje dvaput.
  const mail = outbox.preuzmi(id);
  if (!mail) {
    await ctx.answerCbQuery('Predlog je istekao ili je već obrađen.').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Šaljem...').catch(() => {});
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});

  try {
    const rezultat = await sendMail(mail);
    await ctx.reply(`✅ Mejl poslat na ${mail.to}.`);
    logger.info(`Mejl ${id} poslat nakon potvrde vlasnika (${rezultat.messageId ?? '-'}).`);
  } catch (err) {
    logger.error('Slanje mejla nije uspelo:', err.message);
    await ctx.reply(`⚠️ Slanje nije uspelo: ${err.message}`);
  }
});

// ------------------------------------------------ potvrda izrade fakture ---

/**
 * Šalje vlasniku gotov PDF fakture na pregled, sa dugmadima za arhiviranje.
 * PDF ide kao dokument da može da se otvori i proveri pre nego što ode na
 * Drive i u arhivu — kod finansijskog dokumenta sažetak nije dovoljan.
 */
export async function zatraziPotvrduFakture(id, pdf, opis, broj) {
  await bot.telegram.sendDocument(
    config.telegram.ownerChatId,
    { source: pdf, filename: `Racun ${broj}.pdf` },
    {
      caption: opis.length > 1000 ? `${opis.slice(0, 1000)}…` : opis,
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ Sačuvaj', `inv:save:${id}`),
        Markup.button.callback('❌ Odbaci', `inv:cancel:${id}`),
      ]),
    },
  );
}

bot.action(/^inv:(save|cancel):([a-f0-9-]+)$/i, async (ctx) => {
  if (!isOwner(ctx.chat?.id ?? ctx.from?.id)) {
    await ctx.answerCbQuery('Nemaš dozvolu.').catch(() => {});
    return;
  }

  const [, radnja, id] = ctx.match;

  if (radnja === 'cancel') {
    invoices.odbaci(id);
    await ctx.answerCbQuery('Odbačeno.').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply('❌ Faktura nije sačuvana — broj ostaje slobodan za sledeću.');
    return;
  }

  await ctx.answerCbQuery('Snimam...').catch(() => {});
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});

  try {
    const r = await invoices.potvrdiFakturu(id);
    if (!r) {
      await ctx.reply('Predlog je istekao ili je već obrađen. Napravi fakturu ponovo.');
      return;
    }
    await ctx.reply(
      `✅ Faktura ${r.broj} sačuvana.\n\n` +
        `Klijent: ${r.klijent}\n` +
        `Drive: ${r.drive.link}\n` +
        `Notion: ${r.notion.url}`,
    );
  } catch (err) {
    logger.error('Arhiviranje fakture nije uspelo:', err.message);
    await ctx.reply(`⚠️ Nisam uspeo da sačuvam fakturu: ${err.message}`);
  }
});

/**
 * Telegram ograničava poruke na 4096 karaktera — delimo duže poruke.
 *
 * Seče po ZNAKOVIMA, ne po UTF-16 jedinicama: emodži zauzima dve jedinice, pa
 * bi obično `slice` umelo da ga preseče na pola i pošalje pokvaren znak.
 * Kad god može, prelama na kraju reda da poruka ostane čitljiva.
 */
function podeli(text, limit = 4000) {
  const znakovi = [...text];
  const delovi = [];

  for (let i = 0; i < znakovi.length; ) {
    let deo = znakovi.slice(i, i + limit).join('');

    // Ako nismo na kraju, probaj da prelomiš na poslednjem novom redu.
    if (i + limit < znakovi.length) {
      const prelom = deo.lastIndexOf('\n');
      if (prelom > limit * 0.5) deo = deo.slice(0, prelom);
    }

    delovi.push(deo);
    i += [...deo].length;
  }

  return delovi.length ? delovi : [text];
}

async function replyChunked(ctx, text) {
  for (const deo of podeli(text)) {
    await ctx.reply(deo);
  }
}

/**
 * Proaktivno slanje poruke vlasniku (koristi scheduler).
 */
export async function sendMessage(text, chatId = config.telegram.ownerChatId) {
  for (const deo of podeli(text)) {
    await bot.telegram.sendMessage(chatId, deo);
  }
  logger.info('Proaktivna poruka poslata vlasniku.');
}
