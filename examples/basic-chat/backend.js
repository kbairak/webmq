import { WebMQServer } from 'webmq-backend';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';

const rabbitmq = await new RabbitMQContainer(
  'rabbitmq:3.11-management'
).start();

const server = new WebMQServer(
  rabbitmq.getAmqpUrl(),
  'chat_app'
);

await server.start(8080);
console.log('WebMQ server running on ws://localhost:8080');
