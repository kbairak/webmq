import { WebMQServer } from 'webmq-backend';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import amqplib from 'amqplib';

const rabbitmq = await new RabbitMQContainer('rabbitmq:3.11-management').start();

const server = new WebMQServer({
  rabbitmqUrl: rabbitmq.getAmqpUrl(),
  exchangeName: 'stock_order_exchange',
});
await server.start(8080);

// TODO: Perhaps we could use backend's SubscriptionManager here?
const connection = await amqplib.connect(rabbitmq.getAmqpUrl());
const channel = await connection.createChannel();
await channel.assertExchange('stock_order_exchange', 'topic', { durable: false });
const { queue } = await channel.assertQueue('');
await channel.bindQueue(queue, 'stock_order_exchange', 'orders.create');

await channel.consume(queue, async (msg) => {
  const order = JSON.parse(msg.content.toString());

  await new Promise((resolve) => setTimeout(resolve, 2000));

  order.status = 'Retrieving FX rate';
  channel.publish(
    'stock_order_exchange',
    `orders.updated.${order.id}`,
    Buffer.from(JSON.stringify(order)),
  );

  await new Promise((resolve) => setTimeout(resolve, 2000));

  order.fx_rate = 1.1;
  order.amount_usd = order.amount_eur * order.fx_rate;
  order.status = 'Placing order with stock provider';
  channel.publish(
    'stock_order_exchange',
    `orders.updated.${order.id}`,
    Buffer.from(JSON.stringify(order)),
  );

  await new Promise((resolve) => setTimeout(resolve, 2000));

  order.units = order.amount_eur * 0.0428;
  order.status = 'Waiting for delivery';
  channel.publish(
    'stock_order_exchange',
    `orders.updated.${order.id}`,
    Buffer.from(JSON.stringify(order)),
  );

  channel.ack(msg);
});

// TODO: Graceful shutdown
