import dotenv from 'dotenv';
dotenv.config();

import { Bot } from '@maxhub/max-bot-api';

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token || token.trim() === '') {
    console.error('[bot] BOT_TOKEN is missing. Set it in .env or compose env.');
    // чтобы контейнер не перезапускался бесконечно — подождём и завершимся мягко
    await new Promise(r => setTimeout(r, 5000));
    process.exit(1);
  }

  const bot = new Bot(token);

  // Перехват неожиданных ошибок, чтобы не падать в рестарт
  process.on('unhandledRejection', (e) => console.error('[bot] unhandledRejection:', e));
  process.on('uncaughtException', (e) => console.error('[bot] uncaughtException:', e));

  // Подписка на событие (пока только лог, без бизнес-логики)
  bot.on('message_created', async (ctx) => {
    try {
      const msg = ctx.message;
      console.log('[bot] message_created mid=', msg?.body?.mid);
      // здесь позже будет отправка в очередь; сейчас просто ACK-им
    } catch (e) {
      console.error('[bot] handler error:', e);
    }
  });

  await bot.start();
  console.log('[bot] started');

  // держим процесс живым
  setInterval(() => {}, 1 << 30);
}

main().catch(err => {
  console.error('[bot] fatal:', err);
  process.exit(1);
});
