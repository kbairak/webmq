import { WebMQServer } from 'webmq-backend';

const port = 8080;
const rabbitmqUrl = 'amqp://guest:guest@localhost:5672';
const exchangeName = 'webmq_chat_exchange';

const server = new WebMQServer(rabbitmqUrl, exchangeName);

server.start(port).catch(console.error);
