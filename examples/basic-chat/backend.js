import { WebMQServer } from 'webmq-backend';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';

const rabbitmq = await new RabbitMQContainer(
  'rabbitmq:3.11-management'
).start();

const server = new WebMQServer({
  rabbitmqUrl: rabbitmq.getAmqpUrl(),
  exchangeName: 'chat_app',
  port: 8080,
});
// server.logLevel = 'debug';

await server.start();
console.log('WebMQ server running on ws://localhost:8080');
