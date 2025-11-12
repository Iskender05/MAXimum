import amqplib from 'amqplib';
import dotenv from 'dotenv';
dotenv.config();

const QUEUE = process.env.QUEUE_NAME || 'check';
const AMQP_URL = process.env.AMQP_URL;

export async function publishToQueue(data) {
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE, { durable: true });
  ch.sendToQueue(QUEUE, Buffer.from(JSON.stringify(data)), { persistent: true });
  await ch.close();
  await conn.close();
}

export async function consumeQueue(handler) {
  const conn = await amqplib.connect(AMQP_URL);
  const ch = await conn.createChannel();
  await ch.assertQueue(QUEUE, { durable: true });
  ch.prefetch(8);

  console.log(`[queue] waiting for messages in "${QUEUE}"...`);

  ch.consume(QUEUE, async msg => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(payload);
      ch.ack(msg);
    } catch (err) {
      console.error('[queue] error:', err.message);
      ch.nack(msg, false, false);
    }
  });
}
