# WebMQ

A real-time messaging framework that bridges web frontends with RabbitMQ using WebSockets for event-driven architecture.

## Why WebMQ?

Traditional web applications rely on request-response patterns where the client asks for data and waits for a reply. This works well for CRUD operations but falls short for real-time features like live chat, collaborative editing, or status updates. Event-driven development flips this model: applications react to events as they happen, enabling truly responsive user experiences.

While WebSocket libraries exist, WebMQ leverages RabbitMQ's battle-tested message routing, persistence, and clustering capabilities. This means your real-time features inherit decades of messaging reliability. When you need to scale horizontally, simply spin up more backend instances—RabbitMQ handles message distribution seamlessly across your infrastructure.

## Quick Start

Here's a complete real-time chat in under 30 lines:

**Backend** (`server.js`):

```javascript
import { WebMQServer } from 'webmq-backend';

const server = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'chat_app',
  port: 8080
});

await server.start();
console.log('WebMQ server running on ws://localhost:8080');
```

**Frontend** (React component):

```jsx
import { setup, listen, unlisten, publish } from 'webmq-frontend';
import { useState, useEffect } from 'react';

setup('ws://localhost:8080');

export default function Chat() {
  const username = useRef(randomName());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  const onMessageAdded = useCallback((msg) => { setMessages((prev) => [...prev, msg]); }, []);
  useEffect(() => {
    listen('chat.messages', onMessageAdded);
    return () => unlisten('chat.messages', onMessageAdded);
  }, []);

  const sendMessage = (e) => {
    e.preventDefault();
    publish('chat.messages', { id: crypto.randomUUID(), text: input, user: username.current });
    setInput('');
  };

  return (
    <div>
      {messages.map(msg => <p key={msg.id}>{msg.user}: {msg.text}</p>)}
      <form onSubmit={sendMessage}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button>Send</button>
      </form>
    </div>
  );
}
```

> You can run this example with
>
> ```sh
> cd examples/basic-chat
> npm install
> npm run start
> ```

*Note: WebMQ works with any frontend framework—React, Vue, vanilla JavaScript, or anything that can use WebSockets.*

## Core Concepts

WebMQ acts as a bridge between WebSocket connections and RabbitMQ's topic exchange. When a frontend publishes to `user.login`, it's routed through RabbitMQ to any backend services or other frontends listening for `user.*` or `user.login` specifically.

**Topic Routing**: Use patterns like `chat.room.1`, `order.created`, or `user.profile.updated` to organize your events. Subscribers can listen to exact matches (`order.created`) or patterns (`order.*` for all order events).

**Bidirectional Flow**: Frontends can both publish events and subscribe to updates. Backend services can process events and publish results back to specific users or broadcast to all connected clients.

### Server-Side Hooks

WebMQ uses Express-style middleware hooks to intercept and process messages on the backend. Each hook receives a `context` (connection data), `message` (the client request), and `next` function. Call `await next()` to continue to the next hook, return without calling `next` to abort silently, or throw an error to reject the request.

```javascript
// Authentication hook
const authenticationHook = async (context, message, next) => {
  if (message.action === 'auth') {
    const user = await validateToken(message.payload.token);
    if (!user) throw new Error('Invalid token');
    context.user = user;
    return; // Don't call next() for auth messages
  }

  if (!context.user) {
    throw new Error('Authentication required');
  }

  await next(); // Continue to action-specific hooks
};

// Authorization hook - only allow listening to events ending in user's UUID
const authorizationHook = async (context, message, next) => {
  if (message.action === 'listen') {
    const userUUID = context.user.id;
    if (!message.bindingKey.endsWith(userUUID)) {
      throw new Error('Cannot listen to events for other users');
    }
  }

  await next();
};

// Payload enhancement hook - add user ID to all published messages
const payloadEnhancementHook = async (context, message, next) => {
  if (message.action === 'publish') {
    message.payload.userId = context.user.id;
    message.payload.timestamp = Date.now();
  }

  await next();
};

const server = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'secure_app',
  port: 8080,
  hooks: {
    pre: [authenticationHook],        // Runs before all actions
    onListen: [authorizationHook],    // Runs only for 'listen' actions
    onPublish: [payloadEnhancementHook] // Runs only for 'publish' actions
  }
});
```

**Hook Types:**

- **`pre`**: Runs before all actions (identify, publish, listen, unlisten)
- **`onIdentify`**: Runs when client sends initial identification message with sessionId, establishing session queue and consumer
- **`onPublish`**: Runs only when publishing messages, can modify `message.routingKey` and `message.payload`
- **`onListen`**: Runs only when setting up listeners, can modify `message.bindingKey`
- **`onUnlisten`**: Runs only when unsubscribing from listeners, can modify `message.bindingKey`

**Hook Parameters:**

Each hook receives three parameters, matching the backend pattern:

- **`context`**: Persistent object containing `ws` (the WebSocket connection object) and `sessionId` (the session ID, set after identify action). Hooks can add custom properties to store user data or other state across requests.
- **`message`**: Action-specific data containing:
  - `action`: The type of action ('identify', 'publish', 'listen', 'unlisten')
  - `routingKey`: Topic being published to (publish actions)
  - `payload`: Message data (publish, identify actions)
  - `bindingKey`: Topic pattern being listened to (listen, unlisten actions)
  - `sessionId`: Session identifier (identify actions)
  - `messageId`: A unique ID for this message (all actions)
- **`next`**: Function to continue to the next hook or main action

### Client-Side Hooks

WebMQ also supports middleware-style hooks on the frontend to intercept and process messages before they're sent or received. Client-side hooks follow the exact same Express-style pattern as backend hooks, using `context`, `message`, and `next()` parameters.

```javascript
import { setup } from 'webmq-frontend';

// Authentication hook - add JWT token to identify message
const authenticationHook = async (context, message, next) => {
  message.payload = { token: sessionStorage.getItem('authToken') };
  await next();
};

// Logging hook - track all messages
const loggingHook = async (context, message, next) => {
  console.log('Processing:', message.action, message.routingKey || message.bindingKey);
  await next();
};

// Message transformation hook - decrypt incoming messages
const decryptionHook = async (context, message, next) => {
  if (message.payload && message.payload.encrypted) {
    message.payload.data = decrypt(message.payload.encrypted);
    delete message.payload.encrypted;
  }
  await next();
};

setup('ws://localhost:8080', {
  hooks: {
    pre: [loggingHook],                           // Run before all actions
    onIdentify: [authenticationHook],             // Run when establishing connection
    onMessage: [decryptionHook]                   // Run for incoming messages
  }
});
```

**Hook Types:**

- **`pre`**: Runs before all actions (identify, publish, listen, unlisten, message processing)
- **`onIdentify`**: Runs when establishing WebSocket connection, can add authentication data to `message.payload`
- **`onPublish`**: Runs only when publishing messages, can modify `message.routingKey` and `message.payload`
- **`onListen`**: Runs only when setting up listeners, can modify `message.bindingKey`
- **`onUnlisten`**: Runs only when unsubscribing from listeners, can modify `message.bindingKey`
- **`onMessage`**: Runs for all incoming messages, can modify `message.payload` before callbacks

**Hook Parameters:**

Each hook receives three parameters, matching the backend pattern:

- **`context`**: Persistent object containing `client` reference and user data
- **`message`**: Action-specific data containing:
  - `action`: The type of action ('publish', 'listen', 'message')
  - `routingKey`: Topic being published to (publish actions)
  - `payload`: Message data (publish, message actions)
  - `bindingKey`: Topic pattern being listened to (listen, message actions)
  - `callback`: Message handler function (listen actions)
- **`next`**: Function to continue to the next hook or main action

The context persists across different actions, allowing hooks to maintain state:

```javascript
const sessionHook = async (context, message, next) => {
  if (!context.sessionId) {
    context.sessionId = generateSessionId();
  }
  // sessionId will be available in all subsequent hook calls
  await next();
};
```

**Error Handling:**

If a hook throws an error, the action is aborted:

- Publishing: The publish promise rejects
- Listening: The listen promise rejects
- Message processing: The message callback is not called

### Logging Configuration

Both frontend and backend support configurable logging levels for debugging and monitoring:

```javascript
// Frontend logging
import { webMQClient } from 'webmq-frontend';
webMQClient.logLevel = 'debug'; // 'silent' | 'error' | 'warn' | 'info' | 'debug'

// Backend logging
const server = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  port: 8080
});
server.logLevel = 'info';
```

### EventEmitter Events

The WebMQClient extends EventEmitter, providing connection state monitoring:

**Frontend Events:**

- `'connected'`: Initial connection established
- `'disconnected'`: Connection lost
- `'reconnecting'`: Connection is attempting to reconnect (includes retry count in event data)
- `'error'`: WebSocket error occurred

```javascript
// Frontend event monitoring
import { webMQClient } from 'webmq-frontend';
webMQClient.on('connected', () => console.log('Connected'));
webMQClient.on('disconnected', () => console.log('Disconnected'));
webMQClient.on('reconnecting', (event) => console.log('Reconnecting...', event));
```

**Note:** The backend WebMQServer does not currently emit custom events. For backend monitoring, use the built-in logging system by setting `server.logLevel = 'debug'`.

## Features

- **Auto-reconnection**: Exponential backoff handles network interruptions
- **Message acknowledgments**: Guaranteed delivery with Promise-based confirmations
- **Offline queuing**: Messages sent while disconnected are queued and sent on reconnect
- **Graceful shutdowns**: Proper cleanup of connections and resources
- **Flexible authentication**: Middleware-style hooks for custom auth logic
- **Client-side hooks**: Express-style middleware for frontend message processing
- **Topic wildcards**: Subscribe to event patterns with `*` and `#` wildcards
- **Connection events**: React to connect/disconnect/reconnect states
- **Framework agnostic**: Works with React, Vue, Angular, or vanilla JS

## API Reference

### Frontend API

#### Hybrid Singleton Pattern

WebMQ uses a hybrid approach that provides convenience for common use cases while allowing flexibility for advanced scenarios. The exported functions (`setup`, `listen`, `publish`, `unlisten`) are convenience wrappers around a default singleton client instance.

```javascript
// These are equivalent:
import { setup, listen, publish, unlisten } from 'webmq-frontend';
setup('ws://localhost:8080');

// vs
import { WebMQClient } from 'webmq-frontend';
const client = new WebMQClient('ws://localhost:8080');

// or
const client = new WebMQClient();
client.setup('ws://localhost:8080');
```

For advanced features like logging or event monitoring, you can either create a custom instance or import the singleton. See [Logging Configuration](#logging-configuration) and [EventEmitter Events](#eventemitter-events) in Core Concepts.

Multiple clients can be created to connect to different backends:

```javascript
const chatClient = new WebMQClient('ws://chat.example.com');
const analyticsClient = new WebMQClient('ws://analytics.example.com');
```

#### WebMQClient API

**Constructor:**

- `new WebMQClient(url?, hooks?)`: Create new client instance
  - `url` (string, optional): WebSocket URL (e.g., 'ws://localhost:8080')
  - `hooks` (WebMQClientHooks, optional): Client-side middleware hooks

**Configuration Methods:**

- `setup(url, hooks?)` (also available as standalone import): Configure connection
  - `url` (string): WebSocket URL (e.g., 'ws://localhost:8080')
  - `hooks` (WebMQClientHooks, optional): Client-side middleware hooks
    - `pre` (ClientHook[]): Run before all actions
    - `onPublish` (ClientHook[]): Run for 'publish' actions
    - `onListen` (ClientHook[]): Run for 'listen' actions
    - `onUnlisten` (ClientHook[]): Run for 'unlisten' actions
    - `onMessage` (ClientHook[]): Run for incoming messages

**Core Methods:**

- `listen(bindingKey, callback)` (also available as standalone import): Subscribe to events
  - `bindingKey` (string): Topic pattern to subscribe to (supports `*` and `#` wildcards)
  - `callback` (function): Handler receiving payload
  - Returns: Promise<void>
- `unlisten(bindingKey, callback)` (also available as standalone import): Unsubscribe from events
  - `bindingKey` (string): Topic pattern to stop listening to
  - `callback` (function): The specific callback to remove
  - Returns: Promise<void>
- `publish(routingKey, payload)` (also available as standalone import): Publish events
  - `routingKey` (string): Topic to publish to
  - `payload` (any): Data to send (will be JSON.stringify'd)
  - Returns: Promise<void> (resolves on server ACK)

**Properties:**

- `logLevel` (get/set): Control logging verbosity ('silent' | 'error' | 'warn' | 'info' | 'debug')

### Backend API

#### WebMQServer Class

**`new WebMQServer(options)`**

- `options` (WebMQServerOptions): Configuration object extending WebSocket ServerOptions
  - `rabbitmqUrl` (string, required): AMQP connection URL (e.g., 'amqp://localhost')
  - `exchangeName` (string, required): RabbitMQ exchange name (exchanges are always durable topic exchanges)
  - `port` (number, optional): Port to listen on for standalone mode
  - `server` (http.Server | https.Server, optional): Existing HTTP/HTTPS server to attach to
  - `healthCheck` (boolean | string, optional): Enable health check endpoint
    - `true`: Automatically creates endpoint at `/health`
    - `'/custom-path'`: Creates endpoint at specified path
    - Requires either `port` or `server` option to be provided
    - Works with both standalone and attached server modes
  - `hooks` (object, optional): Middleware hooks
    - `pre` (Hook[]): Run before all actions
    - `onIdentify` (Hook[]): Run for 'identify' actions
    - `onPublish` (Hook[]): Run for 'publish' actions
    - `onListen` (Hook[]): Run for 'listen' actions
    - `onUnlisten` (Hook[]): Run for 'unlisten' actions
  - All other options from [ws ServerOptions](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback) (path, perMessageDeflate, etc.)

**Instance Methods:**

- `start()`: Start WebSocket server
- `stop()`: Stop server and cleanup
- `healthCheckHandler()`: Returns a handler function for manual health check setup (useful with Express routing)

**Properties:**

- `logLevel` (get/set): Control logging verbosity ('silent' | 'error' | 'warn' | 'info' | 'debug')

**Examples:**

Standalone mode:

```javascript
const server = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  port: 8080
});
await server.start();
```

With automatic health check:

```javascript
const server = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  port: 3000,
  healthCheck: true  // Creates /health endpoint
});
await server.start();
```

Attached to Express with manual health check:

```javascript
import express from 'express';
import { createServer } from 'http';

const app = express();
const httpServer = createServer(app);

const webmq = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  server: httpServer
});

// Manual health check setup
app.get('/api/health', webmq.healthCheckHandler());

await webmq.start();
httpServer.listen(8080);
```

Attached to Express with automatic health check:

```javascript
import express from 'express';
import { createServer } from 'http';

const app = express();
const httpServer = createServer(app);

const webmq = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  server: httpServer,
  healthCheck: '/health'  // Adds request listener to httpServer
});

await webmq.start();
httpServer.listen(8080);
```

**Health Check Response:**

```json
{
  "status": "healthy",
  "rabbitmq": "connected",
  "websocket": "running",
  "connections": 42
}
```

Returns HTTP 200 when healthy, 503 when unhealthy (RabbitMQ disconnected or WebSocket server stopped).

## Roadmap

### Immediate Improvements

1. Production Readiness

- Better error handling in backend (channel errors, connection recovery)
- Graceful degradation when RabbitMQ is down
- Metrics/monitoring integration (Prometheus?)

2. Performance

- Message batching to reduce overhead
- Compression for large payloads

3. Developer Experience

- TypeScript support in examples
- More example apps (notifications, collaborative editing?)
- Better error messages

### Bigger Features

4. Advanced Patterns

- Request-reply pattern (RPC over WebMQ)
- Message persistence/replay
- Priority queues

5. Security

- TLS/WSS support
- Rate limiting per client
- Message size limits
- Better authentication examples

6. Observability

- Built-in metrics (msg/s, latency, queue depth)
- Distributed tracing
- Admin dashboard

### Nice to Have

7. Alternative Transports

- Redis backend (instead of RabbitMQ)
- Kafka backend
- In-memory backend for testing

8. Framework Integrations

- React hooks package
- Vue composables
- Next.js API routes example

## For Contributors

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm 7+

### Development Setup

1. **Start RabbitMQ**:

   ```bash
   docker-compose up -d
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Build packages**:

   ```bash
   npm run build
   ```

4. **Run example**:

   ```bash
   npm run start:chat
   ```

### Project Structure

```
packages/
├── backend/     # Node.js WebSocket server library
└── frontend/    # Framework-agnostic client library
examples/
├── basic-chat/  # Simple chat application
└── stock_order/ # Async workflow example
e2e-tests/       # Integration tests
```

### Development Commands

```bash
# Build specific packages
npm run build -w webmq-backend
npm run build -w webmq-frontend

# Run tests
npm run test -w webmq-backend
npm run test -w webmq-frontend
npm test  # Run e2e tests

# Development mode
npm run dev -w webmq-backend    # TypeScript watch
npm run dev -w webmq-frontend   # ESBuild watch
```

The RabbitMQ management UI is available at <http://localhost:15672> (guest/guest).
