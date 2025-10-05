import { WebMQServer } from 'webmq-backend';

const port = parseInt(process.argv[2]);
const rabbitmqUrl = process.argv[3];

if (!port || !rabbitmqUrl) {
  console.error('Usage: node backend.js <port> <rabbitmqUrl>');
  process.exit(1);
}

const server = new WebMQServer({
  rabbitmqUrl,
  exchangeName: 'benchmark',
  port
});

server.logLevel = 'silent';

await server.start();
console.log(`Backend started on port ${port}`);
