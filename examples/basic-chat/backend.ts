import WebMQServer from '@webmq-backend';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';

const rabbitmq = await new RabbitMQContainer('rabbitmq:3.11-management').start();

const server = new WebMQServer({
  rmqUrl: rabbitmq.getAmqpUrl(), exchange: 'chat_app', port: 8080, logLevel: 'DEBUG'
});

await server.start();
