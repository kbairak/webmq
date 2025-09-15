import { WebMQBackend } from "webmq-backend";

const RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
const EXCHANGE_NAME = "webmq_exchange";

async function startBackend() {
  const backend = new WebMQBackend({
    rabbitmqUrl: RABBITMQ_URL,
    exchangeName: EXCHANGE_NAME,
  });

  backend
    .start(8080)
    .then(() => {
      console.log("WebMQ Backend started on ws://localhost:8080");
    })
    .catch(console.error);
}

startBackend();
