import { WebMQServer, RabbitMQManager } from 'webmq-backend';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import amqplib from 'amqplib';

const rabbitmq = await new RabbitMQContainer('rabbitmq:3.11-management').start();

const server = new WebMQServer({
  rabbitmqUrl: rabbitmq.getAmqpUrl(),
  exchangeName: 'stock_order_exchange',
});
server.setLogLevel('info');
await server.start(8080);

// Use RabbitMQManager for cleaner AMQP handling
const connection = await amqplib.connect(rabbitmq.getAmqpUrl());
const channel = await connection.createChannel();
await channel.assertExchange('stock_order_exchange', 'topic', { durable: false });

const rabbitMQManager = new RabbitMQManager(channel, 'stock_order_exchange');

await rabbitMQManager.subscribeJSON('orders.create', async (order) => {
  await new Promise((resolve) => setTimeout(resolve, 2000));

  order.status = 'Retrieving FX rate';
  await rabbitMQManager.publish(`orders.updated.${order.id}`, order);

  await new Promise((resolve) => setTimeout(resolve, 2000));

  order.fx_rate = 1.1;
  order.amount_usd = order.amount_eur * order.fx_rate;
  order.status = 'Placing order with stock provider';
  await rabbitMQManager.publish(`orders.updated.${order.id}`, order);

  await new Promise((resolve) => setTimeout(resolve, 2000));

  order.units = order.amount_eur * 0.0428;
  order.status = 'Waiting for delivery';
  await rabbitMQManager.publish(`orders.updated.${order.id}`, order);
});

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  console.log(`Received ${signal}, shutting down gracefully...`);

  try {
    await server.stop();
    await channel.close();
    await connection.close();
    await rabbitmq.stop();
    console.log('Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log('Stock order backend started on http://localhost:8080');
console.log('Press Ctrl+C to stop gracefully');
