import { WebMQServer } from 'webmq-backend';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';

const rabbitmq = await new RabbitMQContainer(
  'rabbitmq:3.11-management'
).start();

const server = new WebMQServer(rabbitmq.getAmqpUrl(), 'todos_exchange');
server.logLevel = 'debug';
await server.start(8080);

console.log('Todo backend running on ws://localhost:8080');
console.log('RabbitMQ management UI: http://localhost:15672 (guest/guest)');
