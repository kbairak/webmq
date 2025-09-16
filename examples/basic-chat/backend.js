import { WebMQServer } from "webmq-backend";

const port = 8080;
const rabbitmqUrl =
  process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672";
const exchangeName = "webmq_chat_exchange";

// Example of a validation hook for emits
const emitValidationHook = async (context, message, next) => {
  console.log(`[Hook] Validating emit message from ${context.id}`);
  if (
    !message.payload ||
    typeof message.payload.text !== "string" ||
    message.payload.text.trim() === ""
  ) {
    throw new Error("Invalid chat message payload: text cannot be empty.");
  }
  await next(); // Continue to the next hook or the main logic
};

// Example of a validation hook for listens
const listenValidationHook = async (context, message, next) => {
  console.log(`[Hook] Validating listen message from ${context.id}`);
  if (message.bindingKey !== "chat.room.1") {
    throw new Error("Unknown chat room");
  }
  await next();
};

const server = new WebMQServer({
  rabbitmqUrl,
  exchangeName,
  hooks: {
    onEmit: [emitValidationHook],
    onListen: [listenValidationHook],
  },
});

server.start(port).catch(console.error);
