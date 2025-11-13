// src/bot/handler.js
import dotenv from "dotenv";
dotenv.config();

import { Bot } from "@maxhub/max-bot-api";
import { findUrl, ensureUrl } from "../db/queries.js";
import { publishToQueue } from "../queue/rabbit.js";
import { extractUrls } from "../utils/extractUrls.js";
import { query } from "../db/index.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token || token.trim() === "") {
    console.error("[bot] BOT_TOKEN is missing. Set it in .env or compose env.");
    await new Promise((r) => setTimeout(r, 5000));
    process.exit(1);
  }

  const bot = new Bot(token);

  // /start
  bot.command("start", async (ctx) =>
    ctx.reply(
      "Привет! Я — бот, который помогает избегать переходов по вредным ссылкам и скачиванию файлов.\n\n" +
        "Мой основной функционал — проверка ссылок и файлов на безопасность.\n\n" +
        "Ты можешь добавить меня в свою группу для автоматической проверки или писать мне в личку.\n" +
        "Будь уверен, что твоя безопасность в надёжных руках! 🚀",
    ),
  );

  // общий обработчик входящих сообщений
  bot.on("message_created", async (ctx) => {
    const msg = ctx.message;
    if (!msg) {
      console.warn("[bot] no message in ctx");
      return;
    }

    const body = msg.body || {};
    const recipient = msg.recipient || {};
    const sender = msg.sender || {};

    try {
      const items = extractUrls(msg);
      if (!items.length) {
        return; // нет ни ссылок, ни файлов
      }

      // Один аккуратный ответ пользователю
      if (items.length === 1) {
        const { url, type } = items[0];
        await ctx.reply(
          type === "file"
            ? "📁 Файл получен, начинаю проверку..."
            : `🔍 Проверяю ссылку:\n${url}`,
        );
      } else {
        await ctx.reply(
          `🔍 Найдено ${items.length} объектов (ссылки/файлы), запускаю проверку...`,
        );
      }

      const chatTypeRaw = recipient.chat_type; // 'dialog' | 'chat'
      const chatForQueue = {
        chat_id: recipient.chat_id,
        chat_type: chatTypeRaw,
        user_id: recipient.user_id ?? sender.user_id ?? null,
      };

      for (const item of items) {
        const { url, type } = item;


        // 2) url в таблице url
        const urlRow = await processUrl(url, type);

        // 3) учёт в user_url (только если не личка)
        if (chatTypeRaw !== "dialog" && sender.user_id && urlRow?.url_id) {
          await handleUserUrl(sender.user_id, urlRow.url_id);
        }

        // 4) отправка задания в очередь
        const payload = {
          message_id: body.mid,
          url,
          type,
          chat: chatForQueue,
        };

        if (item.file_id) payload.file_id = item.file_id;
        if (item.file_token) payload.file_token = item.file_token;

        await publishToQueue(payload);
        console.log("[bot] URL queued:", JSON.stringify(payload));
      }
    } catch (e) {
      console.error("[bot] handler error:", e);
    }
  });

  await bot.start();
  console.log("[bot] started");

  // чтобы процесс не завершился
  setInterval(() => {}, 1 << 30);
}

async function processUrl(url, type) {
  const existing = await findUrl(url);
  if (!existing) {
    return await ensureUrl(url, type);
  }
  return existing;
}

async function handleUserUrl(maxUserId, urlId) {
  const { rows } = await query(
    "SELECT * FROM user_url WHERE max_user_id=$1 AND url_id=$2",
    [maxUserId, urlId],
  );

  if (!rows.length) {
    await query(
      "INSERT INTO user_url(max_user_id, url_id, number) VALUES($1,$2,1)",
      [maxUserId, urlId],
    );
    return 1;
  } else {
    const current = Number(rows[0].number || 0);
    const next = current + 1;
    await query(
      "UPDATE user_url SET number=$1 WHERE max_user_id=$2 AND url_id=$3",
      [next, maxUserId, urlId],
    );
    return next;
  }
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
