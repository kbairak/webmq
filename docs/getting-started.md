# Getting Started

Build a real-time chat app in under 30 lines.

## Prerequisites

- Node.js 18+
- Docker (for RabbitMQ)

## Installation

```bash
npm install webmq-backend webmq-frontend
```

## 1. Start RabbitMQ

```bash
docker run -d --name webmq-rabbitmq -p 5672:5672 rabbitmq:3.11-management
```

## 2. Backend

Create `server.js`:

```javascript
import WebMQServer from 'webmq-backend';

const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'chat_app',
  port: 8080
});

await server.start();
console.log('WebMQ server running on ws://localhost:8080');
```



That's it. The server connects to RabbitMQ, creates a topic exchange named `chat_app`, and starts a WebSocket server on port 8080.

## 3. Frontend

Create a simple HTML page with a script tag — no framework needed.

```html
<!DOCTYPE html>
<html>
<body>
  <div id="messages"></div>
  <input id="input" placeholder="Type a message..." />
  <button id="send">Send</button>

  <script type="module">
    import WebMQClient from 'webmq-frontend';

    const client = new WebMQClient({
      url: 'ws://localhost:8080',
      sessionId: crypto.randomUUID()
    });
    client.connect();

    // Listen for messages
    client.listen('chat.messages', (msg) => {
      const div = document.getElementById('messages');
      div.innerHTML += `<p><b>${msg.user}:</b> ${msg.text}</p>`;
    });

    // Publish messages
    const user = 'User-' + Math.floor(Math.random() * 1000);
    document.getElementById('send').onclick = () => {
      const input = document.getElementById('input');
      client.publish('chat.messages', {
        id: crypto.randomUUID(),
        text: input.value,
        user
      });
      input.value = '';
    };
  </script>
</body>
</html>
```

## 4. Run it

Open the HTML file in a browser. Open it in a second browser tab. Messages typed in one tab appear in the other in real-time.

## What just happened?

1. The frontend connected to the backend via WebSocket
2. The backend assigned it a session queue on RabbitMQ
3. `listen('chat.messages', ...)` bound that queue to the `chat_app` exchange with binding key `chat.messages`
4. `publish('chat.messages', ...)` sent a message to RabbitMQ
5. RabbitMQ routed the message to all bound queues — one per connected client
6. The backend forwarded it to each client via their WebSocket

This is the core pattern. Everything else WebMQ offers — hooks, workers, horizontal scaling, reconnection — builds on this foundation.

## Next steps

- See how to [integrate with React](react.md), [React Native](react-native.md), or [vanilla JS](vanilla-js.md)
- Understand the [architecture](architecture.md) behind the scenes
- Learn about [cross-language workers](cross-language.md) in Python, Go, and more
