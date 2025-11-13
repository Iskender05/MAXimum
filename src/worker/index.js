// src/worker/index.js
import dotenv from 'dotenv';
dotenv.config();

import amqplib from 'amqplib';
import pg from 'pg';
import { Bot } from '@maxhub/max-bot-api';
import { findUrl, ensureUrl, saveUrlResult } from '../db/queries.js';

const AMQP_URL   = process.env.AMQP_URL;
const QUEUE_NAME = process.env.QUEUE_NAME || 'check';
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN  = process.env.BOT_TOKEN;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log('[worker]', ...a);
const warn  = (...a) => console.warn('[worker]', ...a);
const error = (...a) => console.error('[worker]', ...a);

// --- PG ----------------------------------------------------
const pool = new pg.Pool({ connectionString: DATABASE_URL });

// --- Bot API для ответов -----------------------------------
let bot = null;
async function getBot() {
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is not set for worker');
  }
  if (!bot) {
    bot = new Bot(BOT_TOKEN);
    // запустим один раз, без хендлеров (воркер только отправляет)
    bot.start().catch(e => warn('bot.start error (worker):', e.message));
  }
  return bot;
}

async function sendReply(chat, message_id, text) {
  try {
    const botInstance = await getBot();
    const replyLink = message_id ? { link: { type: 'reply', mid: message_id } } : undefined;

    if (chat.type === 'chat') {
      await botInstance.api.sendMessageToChat(chat.id, text, replyLink);
    } else {
      await botInstance.api.sendMessageToUser(chat.id, text, replyLink);
    }
  } catch (e) {
    warn('sendReply failed:', e.message);
  }
}

// --- Проверки ссылки/файла (заглушки) -----------------------
async function checkLink(url) {
  // здесь будет реальная проверка; пока — заглушка
  return { verdict: 'clean' };
}

async function checkFile(fileIdOrToken) {
  return { verdict: 'no-malware' };
}

// --- Обработка одного задания из очереди -------------------
async function processTask(payload) {
  const { message_id, url, type, chat } = payload || {};
  if (!url || !type || !chat?.id) {
    warn('bad payload:', payload);
    return;
  }

  // 1. На всякий случай ensure url в БД (если его не создал бот по какой-то причине)
  const row = (await findUrl(url)) ?? (await ensureUrl(url, type));

  // 2. Если результат уже есть — не проверяем повторно
  let verdict = row.result;
  if (!verdict) {
    if (type === 'file') {
      const res = await checkFile(url);
      verdict = res.verdict;
    } else {
      const res = await checkLink(url);
      verdict = res.verdict;
    }
    // сохраняем только текст verdict (например, "clean")
    await saveUrlResult(row.url_id, verdict);
  }

  // 3. Отправляем ответ пользователю/в чат
  const text =
    type === 'file'
      ? `Файл проверен. Статус: ${verdict}`
      : `Ссылка проверена: ${url}\nСтатус: ${verdict}`;

  await sendReply(chat, message_id, text);
  log('processed url:', url, 'verdict:', verdict);
}

// --- Основной цикл worker -----------------------------------
async function main() {
  if (!AMQP_URL) {
    throw new Error('AMQP_URL is not set');
  }

  let conn;
  for (;;) {
    try {
      conn = await amqplib.connect(AMQP_URL);
      log('connected to RabbitMQ');
      break;
    } catch (e) {
      warn('RabbitMQ not ready:', e.message);
      await sleep(1000);
    }
  }

  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE_NAME, { durable: true });
  ch.prefetch(10);
  log(`waiting for messages in "${QUEUE_NAME}"...`);

  ch.consume(
    QUEUE_NAME,
    async (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        await processTask(payload);
        ch.ack(msg);
      } catch (e) {
        error('task error:', e);
        ch.nack(msg, false, false); // не перекидываем назад, чтобы не зациклиться
      }
    },
    { noAck: false },
  );

  // чтобы процесс не завершался
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  error('fatal:', e);
  setInterval(() => {}, 1 << 30);
});
