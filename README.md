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
  exchangeName: 'chat_app'
});

await server.start(8080);
console.log('WebMQ server running on ws://localhost:8080');
```

**Frontend** (React component):

```jsx
import { setup, listen, publish } from 'webmq-frontend';
import { useState, useEffect } from 'react';

setup('ws://localhost:8080');

export function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    listen('chat.messages', (msg) => {
      setMessages(prev => [...prev, msg]);
    });
  }, []);

  const sendMessage = () => {
    publish('chat.messages', { text: input, user: 'Alice' });
    setInput('');
  };

  return (
    <div>
      {messages.map(msg => <div key={msg.id}>{msg.user}: {msg.text}</div>)}
      <input value={input} onChange={e => setInput(e.target.value)} />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
}
```

*Note: WebMQ works with any frontend framework—React, Vue, vanilla JavaScript, or anything that can use WebSockets.*

## Core Concepts

WebMQ acts as a bridge between WebSocket connections and RabbitMQ's topic exchange. When a frontend publishes to `user.login`, it's routed through RabbitMQ to any backend services or other frontends listening for `user.*` or `user.login` specifically.

**Topic Routing**: Use patterns like `chat.room.1`, `order.created`, or `user.profile.updated` to organize your events. Subscribers can listen to exact matches (`order.created`) or patterns (`order.*` for all order events).

**Bidirectional Flow**: Frontends can both publish events and subscribe to updates. Backend services can process events and publish results back to specific users or broadcast to all connected clients.

**Hooks**: WebMQ uses Express-style middleware hooks to intercept and process messages. Each hook receives a `context` (connection data), `message` (the client request), and `next` function. Call `await next()` to continue to the next hook, return without calling `next` to abort silently, or throw an error to reject the request.

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
  hooks: {
    pre: [authenticationHook],        // Runs before all actions
    onListen: [authorizationHook],    // Runs only for 'listen' actions
    onPublish: [payloadEnhancementHook] // Runs only for 'publish' actions
  }
});
```

## Features

- **Auto-reconnection**: Exponential backoff handles network interruptions
- **Message acknowledgments**: Guaranteed delivery with Promise-based confirmations
- **Offline queuing**: Messages sent while disconnected are queued and sent on reconnect
- **Graceful shutdowns**: Proper cleanup of connections and resources
- **Flexible authentication**: Middleware-style hooks for custom auth logic
- **Topic wildcards**: Subscribe to event patterns with `*` and `#` wildcards
- **Connection events**: React to connect/disconnect/reconnect states
- **Framework agnostic**: Works with React, Vue, Angular, or vanilla JS

## API Reference

### Frontend API

#### Hybrid Singleton Pattern

WebMQ uses a hybrid approach that provides convenience for common use cases while allowing flexibility for advanced scenarios. The exported functions (`setup`, `listen`, `publish`, etc.) are convenience wrappers around a default singleton client instance.

```javascript
// These are equivalent:
import { setup, listen, publish } from 'webmq-frontend';
setup('ws://localhost:8080');

// vs
import { WebMQClient } from 'webmq-frontend';
const client = new WebMQClient('ws://localhost:8080');

// or
const client = new WebMQClient();
client.setup('ws://localhost:8080');
```

For advanced features like logging or queue monitoring, you can either create a custom instance or import the singleton:

```javascript
// Custom instance approach
const client = new WebMQClient('ws://localhost:8080');
client.setLogLevel('debug');
client.on('connect', () => console.log('Connected'));

// Singleton approach
import { client } from 'webmq-frontend';
client.setLogLevel('debug');
client.on('connect', () => console.log('Connected'));
```

Multiple clients can be created to connect to different backends:

```javascript
const chatClient = new WebMQClient('ws://chat.example.com');
const analyticsClient = new WebMQClient('ws://analytics.example.com');
```

#### WebMQClient API

**Constructor:**

- `new WebMQClient(url?, options?)`: Create new client instance
  - `url` (string, optional): WebSocket URL
  - `options` (object, optional): Configuration options

**Configuration Methods:**

- `setup(url, options?)` (also available as standalone import): Configure connection
  - `url` (string): WebSocket URL (e.g., 'ws://localhost:8080')
  - `options` (object, optional):
    - `maxReconnectAttempts` (number): Default 5
    - `messageTimeout` (number): Timeout in ms, default 10000
    - `maxQueueSize` (number): Offline queue size, default 100

**Core Methods:**

- `connect()` (also available as standalone import): Explicitly connect to server
  - Returns: Promise<void>
  - Note: Auto-called by listen/publish
- `listen(bindingKey, callback)` (also available as standalone import): Subscribe to events
  - `bindingKey` (string): Topic pattern to subscribe to
  - `callback` (function): Handler receiving payload
  - Returns: Promise<void>
- `publish(routingKey, payload)` (also available as standalone import): Publish events
  - `routingKey` (string): Topic to publish to
  - `payload` (any): Data to send (will be JSON.stringify'd)
  - Returns: Promise<void> (resolves on server ACK)
- `disconnect(options?)` (also available as standalone import): Disconnect from server
  - `options` (object, optional):
    - `onActiveListeners` ('ignore' | 'throw' | 'clear'): Default 'ignore'

**Advanced Methods:**

- `setLogLevel(level)`: Set logging level
  - `level` ('silent' | 'error' | 'warn' | 'info' | 'debug')
- `getQueueSize()`: Get number of queued offline messages
  - Returns: number
- `clearQueue()`: Clear all queued messages

**Events (extends EventEmitter):**

- `'connect'`: Initial connection established
- `'disconnect'`: Connection lost
- `'reconnect'`: Connection restored after being lost

### Backend API

#### WebMQServer Class

**`new WebMQServer(options)`**

- `options` (object):
  - `rabbitmqUrl` (string): AMQP connection URL
  - `exchangeName` (string): RabbitMQ exchange name
  - `exchangeDurable` (boolean, optional): Default false
  - `hooks` (object, optional):
    - `pre` (Hook[]): Run before all actions
    - `onListen` (Hook[]): Run for 'listen' actions
    - `onPublish` (Hook[]): Run for 'publish' actions
    - `onUnlisten` (Hook[]): Run for 'unlisten' actions

**Instance Methods:**

- `start(port)`: Start WebSocket server on port
- `stop()`: Stop server and cleanup
- `setLogLevel(level)`: Set logging level

**Events (extends EventEmitter):**

- `'client.connected'`: { connectionId }
- `'client.disconnected'`: { connectionId }
- `'message.received'`: { connectionId, message }
- `'message.processed'`: { connectionId, message }
- `'subscription.created'`: { connectionId, bindingKey, queue }
- `'subscription.removed'`: { connectionId, bindingKey }
- `'error'`: { connectionId?, error, context? }

### Usage Examples

**Basic Setup**:

```javascript
// Frontend
import { setup, listen, publish } from 'webmq-frontend';
setup('ws://localhost:8080');
listen('notifications.*', console.log);
await publish('user.action', { type: 'click' });

// Backend
import { WebMQServer } from 'webmq-backend';
const server = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app'
});
await server.start(8080);
```

**Connection State Monitoring**:

```javascript
import { client } from 'webmq-frontend';
client.on('connect', () => console.log('Connected'));
client.on('disconnect', () => console.log('Disconnected'));
console.log(`Queue size: ${client.getQueueSize()}`);
```

**Error Handling**:

```javascript
try {
  await publish('critical.data', payload);
} catch (error) {
  if (error.message.includes('timeout')) {
    // Retry logic
  } else {
    // Handle other errors
  }
}
```

## Future Features

- **Request-response pattern**: `const result = await request('user.get', { id: 123 })`
- **Presence system**: Track which users are online/offline
- **Room/namespace support**: Isolate message spaces for multi-tenant apps
- **Rate limiting**: Per-connection and per-user message throttling
- **Message persistence**: Store-and-forward for offline clients
- **Health checks**: Monitoring endpoints for production deployments
- **Alternative serialization**: MessagePack for performance-critical applications

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
