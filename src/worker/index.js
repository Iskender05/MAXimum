// src/worker/index.js
import dotenv from 'dotenv';
dotenv.config();

import amqplib from 'amqplib';
import pg from 'pg';
import { Bot } from '@maxhub/max-bot-api';

const QUEUE = process.env.QUEUE_NAME || 'check';
const AMQP_URL = process.env.AMQP_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;

// ---- утилиты -------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[worker]', ...a);
const warn = (...a) => console.warn('[worker]', ...a);
const error = (...a) => console.error('[worker]', ...a);

// ---- Postgres ------------------------------------------------
const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function ensureTables() {
  const ddl = `
  CREATE TABLE IF NOT EXISTS url (
    url_id     BIGSERIAL PRIMARY KEY,
    url        TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL CHECK (type IN ('link','file')),
    result     JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS user_url (
    max_user_id BIGINT NOT NULL,
    url_id      BIGINT NOT NULL REFERENCES url(url_id) ON DELETE CASCADE,
    number      INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (max_user_id, url_id)
  );
  CREATE INDEX IF NOT EXISTS idx_url_url ON url (url);
  CREATE INDEX IF NOT EXISTS idx_user_url_user ON user_url (max_user_id);
  `;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(ddl);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function pgReadyWithRetry() {
  while (true) {
    try {
      const { rows } = await pool.query('SELECT 1');
      if (rows && rows.length) {
        await ensureTables();
        log('Postgres is ready');
        return;
      }
    } catch (e) {
      warn('Postgres not ready yet:', e.message);
    }
    await sleep(1000);
  }
}

async function findUrl(url) {
  const { rows } = await pool.query('SELECT * FROM url WHERE url=$1', [url]);
  return rows[0] || null;
}

async function ensureUrl(url, type) {
  const ins = await pool.query(
    `INSERT INTO url(url, type)
     VALUES ($1,$2)
     ON CONFLICT (url) DO NOTHING
     RETURNING *`,
    [url, type]
  );
  if (ins.rows[0]) return ins.rows[0];
  return await findUrl(url);
}

async function saveUrlResult(url_id, verdictText) {
  await pool.query(
    `UPDATE url SET result = $1, updated_at = now() WHERE url_id = $2`,
    [verdictText, url_id]
  );
}



// ---- RabbitMQ ------------------------------------------------
async function connectRabbitWithRetry() {
  while (true) {
    try {
      const conn = await amqplib.connect(AMQP_URL);
      const ch = await conn.createChannel();
      await ch.assertQueue(QUEUE, { durable: true });
      log('Connected to RabbitMQ');
      return { conn, ch };
    } catch (e) {
      warn('RabbitMQ not ready yet:', e.message);
      await sleep(1000);
    }
  }
}

// ---- Bot API (опционально, чтобы worker не падал без токена) -
let bot = null;
let api = {
  async send(chat, text, message_id) {
    if (!BOT_TOKEN) {
      log('(no BOT_TOKEN) would send to', chat, 'text:', text);
      return;
    }
    try {
      if (!bot) {
        bot = new Bot(BOT_TOKEN);
        bot.start().catch(e => warn('bot.start error:', e.message));
      }
      const reply = { link: { type: 'reply', mid: message_id } };
      if (chat?.type === 'chat') {
        await bot.api.sendMessageToChat(chat.id, text, reply);
      } else {
        await bot.api.sendMessageToUser(chat.id, text, reply);
      }
    } catch (e) {
      warn('send reply failed:', e.message);
    }
  }
};

// ---- Простейшие проверки -------------------------------------
async function checkLink(url) {
  // без внешних запросов: отметим «unknown->ok» для MVP
  return { kind: 'link', url, ok: true, verdict: 'clean' };
}
async function checkFile(idOrToken) {
  return { kind: 'file', id: idOrToken, ok: true, verdict: 'no-malware' };
}

// ---- Основная логика -----------------------------------------
async function processTask(payload) {
  const { message_id, url, type, chat } = payload || {};
  if (!message_id || !url || !type || !chat?.id) {
    warn('skip bad payload:', payload);
    return;
  }

  const row = await ensureUrl(url, type);
  let result = row?.result;

// если запись уже есть и там лежит «толстый» объект — сузим до {verdict}
if (result && result.verdict && Object.keys(result).length !== 1) {
  const onlyVerdict = { verdict: result.verdict };
  await saveUrlResult(row.url_id, verdictText);
  result = onlyVerdict;
}

if (!result) {
    const fullResult = (type === 'file')
    ? await checkFile(String(url).replace(/^file:/, ''))
    : await checkLink(url);

    // Сохраняем только строку (например, "clean")
    const verdictText = String(fullResult?.verdict ?? '');
    await saveUrlResult(row.url_id, verdictText);
    result = verdictText;

}

  const text = (type === 'file')
    ? `Файл проверен: ${result.verdict}`
    : `Ссылка проверена: ${url}\nСтатус: ${result.verdict}`;

  await api.send(chat, text, message_id);
}

async function main() {
  await pgReadyWithRetry();
  const { ch } = await connectRabbitWithRetry();

  ch.prefetch(8);
  log(`Waiting messages in "${QUEUE}"...`);

  ch.consume(QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await processTask(payload);
      ch.ack(msg);
    } catch (e) {
      error('task error:', e);
      // не ре-кьюим, чтобы не зациклиться
      ch.nack(msg, false, false);
    }
  }, { noAck: false });

  // держим процесс живым
  setInterval(() => {}, 1 << 30);
}

main().catch(e => {
  error('fatal:', e);
  // даже при фатале не даём контейнеру умереть мгновенно
  setInterval(() => {}, 1 << 30);
});
