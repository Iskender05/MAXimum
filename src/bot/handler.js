import dotenv from "dotenv";
dotenv.config();

import { Bot } from "@maxhub/max-bot-api";
import { processUrl, handleUserUrl, getUserDangerousStats, getMultipleUsersDangerousStats } from "../db/queries.js";
import { publishToQueue } from "../queue/rabbit.js";
import { extractUrls } from "../utils/extractUrls.js";

// Хранилище для отслеживания уже обработанных событий
const processedEvents = new Set();

function getEventKey(chatId, userId = null) {
  return userId ? `user_${chatId}_${userId}` : `bot_${chatId}`;
}

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token || token.trim() === "") {
    console.error("[bot] BOT_TOKEN is missing. Set it in .env or compose env.");
    await new Promise((r) => setTimeout(r, 5000));
    process.exit(1);
  }

  const bot = new Bot(token);

  // при запуске бота
  bot.on("bot_started", async (ctx) =>
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
      let items = extractUrls(msg.body);
      if(msg?.link && msg.link.type === "forward"){
        items = items.concat(extractUrls(msg.link.message));
      }
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

  // при добавлении бота в группу
  bot.on("bot_added", async (ctx) => {
    try {
      const chatId = ctx.update.chat_id;
      const eventKey = getEventKey(chatId);
      
      // --------------------- Проверяем, не обрабатывали ли мы уже это событие ---------------------
      if (processedEvents.has(eventKey)) {
        console.log(`[bot] bot_added event for chat ${chatId} already processed, skipping`);
        return;
      }
      
      processedEvents.add(eventKey);
      console.log(`[bot] added to chat ${chatId}`);

      // --------------------- Устанавливаем таймер для очистки события (через 10 секунд) ---------------------
      setTimeout(() => {
        processedEvents.delete(eventKey);
      }, 10000);

      // 0) Отправляем общее приветственное сообщение
      await ctx.api.raw.post('messages', {
        body: { 
          text: "👋 Привет! Я бот для проверки безопасности. Я буду автоматически проверять все ссылки и файлы в этом чате на вредоносность. Но чтобы я мог обрабатывать сообщения, назначьте меня администратором, пожалуйста.\n\nЕсли обнаружу подозрительные материалы, я предупрежу участников." 
        },
        query: { chat_id: chatId }
      });

      // 1) Получаем список всех пользователей группы
      let allMembers = [];
      let marker = null;
      
      do {
        const params = { count: 100 };
        if (marker) params.marker = marker;
        
        const membersResponse = await ctx.api.raw.get(`chats/${chatId}/members`, {
          query: params
        });
        
        allMembers = allMembers.concat(membersResponse.members);
        marker = membersResponse.marker;
      } while (marker);

      // 2) Проверяем всех пользователей по БД
      const humanMembers = allMembers.filter(member => !member.is_bot);
      const userIds = humanMembers.map(member => member.user_id);
      
      const dangerousStats = await getMultipleUsersDangerousStats(userIds);
      const statsMap = new Map(
        dangerousStats.map(stat => [stat.max_user_id, parseInt(stat.total_dangerous) || 0])
      );

      let dangerousUsers = [];
      let suspiciousUsers = [];

      for (const member of humanMembers) {
        const userId = member.user_id;
        const totalDangerous = statsMap.get(userId) || 0;

        if (totalDangerous > 5) {
          dangerousUsers.push({ name: member.first_name, id: userId });
        } else if (totalDangerous > 0) {
          suspiciousUsers.push({ name: member.first_name, id: userId });
        }
      }

      // 3) Отправляем сообщения в чат
      let message = "✅ Ни у одного пользователя из данной группы не было замечено случаев отправки вредоносных ссылок или файлов!";
      if (dangerousUsers.length > 0) {
        message = "⚠️ Опасные пользователи в этой группе:\n\n";
        dangerousUsers.forEach(user => {
          message += `• ${user.name} (ID: ${user.id}) - часто скидывал вредоносные ссылки или файлы\n`;
        });
      } else if (suspiciousUsers.length > 0) {
        message = "🔍 Подозрительные пользователи в этой группе:\n\n";
        suspiciousUsers.forEach(user => {
          message += `• ${user.name} (ID: ${user.id}) - бывали случаи отправки вредоносных ссылок или файлов\n`;
        });
      }

      await ctx.reply(message);

      console.log(`[bot] Finished security check for chat ${chatId}. Found ${dangerousUsers.length} dangerous and ${suspiciousUsers.length} suspicious users`);

    } catch (error) {
      console.error('[bot] Error in bot_added handler:', error);
    }
  });

  // при добавлении пользователя в группу
  bot.on("user_added", async (ctx) => {
    try {
      const chatId = ctx.update.chat_id;
      const user = ctx.update.user;
      
      // Пропускаем ботов
      if (user.is_bot) return;

      const eventKey = getEventKey(chatId, user.user_id);
      
      // --------------------- Проверяем, не обрабатывали ли мы уже это событие ---------------------
      if (processedEvents.has(eventKey)) {
        console.log(`[bot] user_added event for user ${user.user_id} in chat ${chatId} already processed, skipping`);
        return;
      }
      
      processedEvents.add(eventKey);
      console.log(`[bot] user ${user.user_id} added to chat ${chatId}`);

      // --------------------- Устанавливаем таймер для очистки события (через 10 секунд) ---------------------
      setTimeout(() => {
        processedEvents.delete(eventKey);
      }, 10000);

      // Проверяем пользователя по БД
      const stats = await getUserDangerousStats(user.user_id);
      const totalDangerous = parseInt(stats?.total_dangerous) || 0;

      // Отправляем сообщение в чат в зависимости от уровня опасности
      let message = `✅ У пользователя ${user.first_name} (ID: ${user.user_id}) не было замечено никакой подозрительной активности.`;
      if (totalDangerous > 5) {
        message = `⚠️ Внимание! Добавлен опасный пользователь ${user.first_name} (ID: ${user.user_id}). Он часто скидывал вредоносные ссылки или файлы.`;
        console.log(`[bot] Sent danger warning for user ${user.user_id} in chat ${chatId}`);
      } else if (totalDangerous > 0) {
        message = `🔍 Внимание! Добавлен подозрительный пользователь ${user.first_name} (ID: ${user.user_id}). У него бывали случаи отправки вредоносных ссылок или файлов.`;
        console.log(`[bot] Sent suspicion warning for user ${user.user_id} in chat ${chatId}`);
      } else {
        console.log(`[bot] User ${user.user_id} is clean, no warning sent`);
      }
      
      await ctx.reply(message);

    } catch (error) {
      console.error('[bot] Error in user_added handler:', error);
    }
  });

  await bot.start();
  console.log("[bot] started");

  // чтобы процесс не завершился
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
