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
    console.error('[bot] BOT_TOKEN is missing. Set it in .env or compose env.');
    await new Promise(r => setTimeout(r, 5000));
    process.exit(1);
  }

  const bot = new Bot(token);

  bot.command('start', async (ctx) => ctx.reply(
    'Привет! Я — бот, который помогает избегать переходов по вредным ссылкам и скачиванию файлов. ' +
    'Мой основной функционал — проверка ссылок и файлов на безопасность.\n\n' +
    'Ты можешь добавить меня в свою группу для автоматической проверки ссылок и файлов или отправлять мне сообщения в личку для анализа.\n' +
    'Будь уверен, что твоя безопасность в надежных руках! 🚀'
  ));

  // Обработка команды /start
  bot.on('message_created', async (ctx) => {
    const msg = ctx.update.message;
    // console.log(msg);

    try {
      const chatType = msg.recipient.chatType; // 'chat' for group, 'personal' for direct messages
      const urls = extractUrls(msg.body);

      for (const { url, type } of urls) {  // деструктуризация для получения url и type
        const url_id = await processUrl(url, type);  // передаем type в процессинг
        if (chatType !== 'dialog') {
          if (msg?.sender) {
            await handleUserUrl(msg.sender.user_id, url_id)
          }
        }

        // отправляем в очередь на обработку
        await publishToQueue({
          message_id: msg.body.mid,
          url,
          type,  // тип ссылки передаем в очередь
          chat: { type: chatType, id: msg.recipient.chat_id },
        });

        console.log(`[bot] URL processed: ${url} with type: ${type}`);
      }
    } catch (e) {
      console.error('[bot] handler error:', e);
    }
  });


  await bot.start();
  console.log('[bot] started');

  setInterval(() => {}, 1 << 30); // keep process alive
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
  const { rows } = await query('SELECT * FROM user_url WHERE max_user_id=$1 AND url_id=$2', [maxUserId, urlId]);
  console.log(rows);
  if (rows.length === 0) {
    // если это первый раз, то создаём запись
    await query('INSERT INTO user_url(max_user_id, url_id, number) VALUES($1, $2, 1)', [maxUserId, urlId]);
    return 1;
  } else {
    // если уже была ссылка, увеличиваем number
    const { number } = rows[0];
    await query('UPDATE user_url SET number=$1 WHERE max_user_id=$2 AND url_id=$3', [number + 1, maxUserId, urlId]);
    return number + 1;
  }
}

main().catch(err => {
  console.error('[bot] fatal:', err);
  process.exit(1);
});
