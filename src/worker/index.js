// src/worker/index.js
import dotenv from "dotenv";
dotenv.config();

import amqplib from "amqplib";
import { Bot } from "@maxhub/max-bot-api";
import { findUrl, ensureUrl, saveUrlResult } from "../db/queries.js";
import { checkUrlWithKaspersky } from "../services/kaspersky.js";


const QUEUE_NAME = process.env.QUEUE_NAME || "check";
const AMQP_URL = process.env.AMQP_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bot = null;
async function getBot() {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not set for worker");
  }
  if (!bot) {
    bot = new Bot(BOT_TOKEN);
    bot.start().catch((e) =>
      console.warn("[worker] bot.start error:", e.message),
    );
  }
  return bot;
}

async function sendReply(chat, message_id, text) {
  try {
    const botInstance = await getBot();
    const replyLink = message_id
      ? { link: { type: "reply", mid: message_id } }
      : undefined;

    const chatId = chat.chat_id;  // <-- ВАЖНО

    await botInstance.api.sendMessageToChat(chatId, text, replyLink);
  } catch (e) {
    console.warn("[worker] sendReply failed:", e.message);
  }
}


async function checkLink(url) {
  // теперь проверяем ссылку через Kaspersky OpenTIP
  const res = await checkUrlWithKaspersky(url);
  // res: { verdict, zone, raw }

  // Можем чуть логировать, чтобы видеть, что реально происходит:
  console.log("[worker] Kaspersky URL verdict:", url, "=>", res.verdict, `(${res.zone})`);

  return res; // важно: есть .verdict
}


async function checkFile(fileId, token) {
  // заглушка; сюда можно прикрутить антивирус / MAX API
  return { verdict: "no-malware" };
}

async function processTask(payload) {
  const { message_id, url, type, chat, file_id, file_token } = payload || {};

  // 1) Валидация payload
  if (!message_id || !url || !type || !chat?.chat_id) {
    console.warn("[worker] skip bad payload:", payload);
    return;
  }

  // 2) Получаем/создаём запись в url
  let row = await findUrl(url);
  if (!row) {
    row = await ensureUrl(url, type);
  }

  // 3) Берём готовый verdict, если уже есть
  let verdict = row.result;

  if (!verdict) {
    // 4) Если нет — проверяем
    let res;
    if (type === "file") {
      res = await checkFile(file_id, file_token);   // пока заглушка
    } else {
      res = await checkLink(url);                   // тут уже Kaspersky
    }

    verdict = String(res?.verdict ?? "unknown");
    await saveUrlResult(row.url_id, verdict);
  }

  // 5) Формируем текст ответа
  const text =
    type === "file"
      ? `Файл проверен.\nСтатус: ${verdict}`
      : `Ссылка проверена: ${url}\nСтатус: ${verdict}`;

  await sendReply(chat, message_id, text);
  console.log("[worker] processed task:", url, "verdict:", verdict);
}



async function main() {
  if (!AMQP_URL) {
    throw new Error("AMQP_URL is not set");
  }

  let conn;
  for (;;) {
    try {
      conn = await amqplib.connect(AMQP_URL);
      console.log("[worker] connected to RabbitMQ");
      break;
    } catch (e) {
      console.warn("[worker] RabbitMQ not ready:", e.message);
      await sleep(1000);
    }
  }

  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE_NAME, { durable: true });
  ch.prefetch(10);
  console.log('[worker] waiting for messages in "%s"...', QUEUE_NAME);

  ch.consume(
    QUEUE_NAME,
    async (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        await processTask(payload);
        ch.ack(msg);
      } catch (e) {
        console.error("[worker] task error:", e);
        ch.nack(msg, false, false);
      }
    },
    { noAck: false },
  );

  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  setInterval(() => {}, 1 << 30);
});
