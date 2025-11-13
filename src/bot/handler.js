// src/bot/handler.js
import dotenv from 'dotenv';
dotenv.config();

import { Bot } from '@maxhub/max-bot-api';
import { findUrl, ensureUrl } from '../db/queries.js';
import { publishToQueue } from '../queue/rabbit.js';
import { extractUrls } from '../utils/extractUrls.js';
import { query } from '../db/index.js';

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token || token.trim() === '') {
    console.error('[bot] BOT_TOKEN is missing. Set it in .env или env compose.');
    await new Promise(r => setTimeout(r, 5000));
    process.exit(1);
  }

  const bot = new Bot(token);

  // /start через стандартный хелпер
  bot.command('start', async (ctx) =>
    ctx.reply(
      'Привет! Я — бот, который помогает избегать переходов по вредным ссылкам и скачиванию файлов. ' +
        'Мой основной функционал — проверка ссылок и файлов на безопасность.\n\n' +
        'Ты можешь добавить меня в свою группу для автоматической проверки ссылок и файлов или отправлять мне сообщения в личку для анализа.\n' +
        'Будь уверен, что твоя безопасность в надёжных руках! 🚀',
    ),
  );

  // универсальный обработчик всех сообщений
  bot.on('message_created', async (ctx) => {
    // у SDK бывает ctx.message и ctx.update.message – поддержим оба
    const msg = ctx.message ?? ctx.update?.message;
    if (!msg) {
      console.warn('[bot] no message in ctx');
      return;
    }

    try {
      // 1) достаём текст
      const body = msg.body || {};
      const text = String(body.text ?? '').trim();
      if (!text) return; // пустое сообщение

      // 2) парсим ссылки ИЗ ТЕКСТА, а не из объекта body
      const rawUrls = extractUrls(text) || [];

      // если extractUrls уже возвращает [{url,type}], то ок;
      // если ["https://..."], превращаем в {url, type:'link'}
      const normalized = rawUrls.map((item) =>
        typeof item === 'string'
          ? { url: item, type: 'link' }
          : { url: item.url, type: item.type || 'link' },
      ).filter(u => u.url); // выкинем пустые

      if (!normalized.length) {
        // просто текст без ссылок
        return;
      }

      // 3) информация о чате/пользователе
      const recipient = msg.recipient || {};
      const sender = msg.sender || {};
      const chatTypeRaw = recipient.chat_type; // 'dialog' или 'chat'

      // то, что улетит в очередь
      const chatForQueue = {
        type: chatTypeRaw === 'chat' ? 'chat' : 'user',
        id: chatTypeRaw === 'chat' ? recipient.chat_id : recipient.user_id,
      };

      const maxUserId = sender.user_id ?? recipient.user_id ?? null;
      const messageId = body.mid;

      for (const { url, type } of normalized) {
        // 4) ensure url в таблице url
        const urlRow = await processUrl(url, type);

        // 5) учёт пользователя в user_url
        // у тебя стояла логика "не считаем личку" – сохраняю её:
        if (chatTypeRaw !== 'dialog' && maxUserId && urlRow?.url_id) {
          await handleUserUrl(maxUserId, urlRow.url_id);
        }

        // 6) отправляем задачу в очередь
        const json_to_queue = {
          message_id: messageId,
          url,
          type,   // 'link' или 'file'
          chat: chatForQueue,
        };

        await publishToQueue(json_to_queue);
        console.log('[bot] URL queued:', JSON.stringify(json_to_queue));
      }
    } catch (e) {
      console.error('[bot] handler error:', e);
    }
  });

  await bot.start();
  console.log('[bot] started');

  // чтобы процесс не умер
  setInterval(() => {}, 1 << 30);
}

async function processUrl(url, type) {
  const existingUrl = await findUrl(url);
  if (!existingUrl) {
    // если не найдено, то добавляем в таблицу с типом
    return await ensureUrl(url, type);
  }
  return existingUrl;
}

async function handleUserUrl(maxUserId, urlId) {
  const { rows } = await query(
    'SELECT * FROM user_url WHERE max_user_id=$1 AND url_id=$2',
    [maxUserId, urlId],
  );

  if (rows.length === 0) {
    // первый раз – создаём запись
    await query(
      'INSERT INTO user_url(max_user_id, url_id, number) VALUES($1, $2, 1)',
      [maxUserId, urlId],
    );
    return 1;
  } else {
    // уже была – увеличиваем number
    const { number } = rows[0];
    const next = Number(number || 0) + 1;
    await query(
      'UPDATE user_url SET number=$1 WHERE max_user_id=$2 AND url_id=$3',
      [next, maxUserId, urlId],
    );
    return next;
  }
}

main().catch((err) => {
  console.error('[bot] fatal:', err);
  process.exit(1);
});
