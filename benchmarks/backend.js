import { WebMQBackend } from "webmq-backend";

const port = 8080;
const rabbitmqUrl =
  process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672";
const exchangeName = "webmq_benchmark_exchange";

// Simple backend without validation hooks for benchmarks
const backend = new WebMQBackend({
  rabbitmqUrl,
  exchangeName,
  hooks: {
    // No validation hooks - allow any messages
  },
});

console.log('Starting WebMQ benchmark backend...');
backend.start(port).catch(console.error);