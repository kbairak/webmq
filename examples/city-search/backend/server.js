import { WebMQServer } from 'webmq-backend';

const server = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'city_search',
  port: 8080,
});

await server.start();
console.log('🚀 WebMQ server running on ws://localhost:8080');
console.log('📊 RabbitMQ management: http://localhost:15672 (guest/guest)');
