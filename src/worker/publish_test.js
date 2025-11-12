// scripts/publish_test.js
import amqplib from 'amqplib';

const QUEUE = process.env.QUEUE_NAME || 'check';
const AMQP_URL = process.env.AMQP_URL || 'amqp://rabbit:rabbit@rabbitmq:5672';

const payload = {
  message_id: 'test-mid-123',            // фейковый mid
  url: 'https://example.com',            // тестовая ссылка
  type: 'link',                          // или "file"
  chat: { type: 'chat', id: 123456789 }, // фейковый чат
  sender_user_id: 111222333
};

const run = async () => {
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE, { durable: true });
  await ch.sendToQueue(QUEUE, Buffer.from(JSON.stringify(payload)), { persistent: true });
  console.log('published:', payload);
  await ch.close(); await conn.close();
};
run().catch(console.error);
