# WebMQ

A real-time messaging framework that bridges web frontends with RabbitMQ using WebSockets for event-driven architecture.

## Why WebMQ?

Traditional web applications rely on request-response patterns where the client asks for data and waits for a reply. This works well for CRUD operations but falls short for real-time features like live chat, collaborative editing, or status updates. Event-driven development flips this model: applications react to events as they happen, enabling truly responsive user experiences.

While WebSocket libraries exist, WebMQ leverages RabbitMQ's battle-tested message routing, persistence, and clustering capabilities. This means your real-time features inherit decades of messaging reliability. When you need to scale horizontally, simply spin up more backend instances—RabbitMQ handles message distribution seamlessly across your infrastructure.

**You can use WebMQ as a replacement for Socket.IO, but with horizontal scaling naturally supported. But** the real power is making the frontend part of a mature distributed event-driven system. When the frontend publishes a message, any backend service out of hundreds can pick it up and process it. Similarly, the frontend can subscribe to events from any service in your infrastructure.

## Quick Start

Here's a complete real-time chat in under 40 lines:

**Backend** (`backend.ts`):

```javascript
import WebMQServer from 'webmq-backend';

const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'chat_app',
  port: 8080,
  logLevel: 'INFO'
});

await server.start();
console.log('WebMQ server running on ws://localhost:8080');
```

**Frontend** (`App.tsx` - React):

```tsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import WebMQClient from 'webmq-frontend';

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  const client = useMemo(() => new WebMQClient({
    url: 'ws://localhost:8080',
    sessionId: crypto.randomUUID()
  }), []);

  const appendMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    client.connect();
    client.listen('chat.messages', appendMessage);
    return () => {
      client.unlisten('chat.messages', appendMessage);
      client.disconnect();
    };
  }, [client, appendMessage]);

  const sendMessage = (e) => {
    e.preventDefault();
    client.publish('chat.messages', {
      id: crypto.randomUUID(),
      text: input,
      user: 'Me'
    });
    setInput('');
  };

  return (
    <div>
      {messages.map(msg => <p key={msg.id}><b>{msg.user}</b>: {msg.text}</p>)}
      <form onSubmit={sendMessage}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button>Send</button>
      </form>
    </div>
  );
}
```

> You can run this example with:
>
> ```sh
> cd examples/basic-chat
> npm install
> npm start
> ```

*Note: WebMQ works with any frontend framework—React, Vue, vanilla JavaScript, React Native, or anything that can use WebSockets.*

## Core Concepts

WebMQ acts as a bridge between WebSocket connections and RabbitMQ's topic exchange. When a frontend publishes to `user.login`, it's routed through RabbitMQ to any backend services or other frontends listening for `user.*` or `user.login` specifically.

**Topic Routing**: Use patterns like `chat.room.1`, `order.created`, or `user.profile.updated` to organize your events. Subscribers can listen to exact matches (`order.created`) or patterns (`order.*` for all order events, `#` for wildcard matching).

**Bidirectional Flow**: Frontends can both publish events and subscribe to updates. Backend services can process events and publish results back to specific users or broadcast to all connected clients.

**Guaranteed Delivery**: Messages from RabbitMQ are only acknowledged after the client confirms receipt, ensuring no messages are lost during network interruptions or reconnections.

### Server-Side Hooks

Hooks allow you to intercept and transform messages on the backend. Each hook is an async function that receives a message header and context, and returns a (possibly modified) header.

```javascript
// Add user metadata from socket auth
const authHook = async (header, context, rmqMessage) => {
  // context.socket.handshake.auth contains the sessionId
  // You can add authentication logic here
  return { ...header, userId: context.sessionId };
};

// Enforce authorization on binding keys
const authzHook = async (header, context, rmqMessage) => {
  if (header.bindingKey && !header.bindingKey.startsWith('public.')) {
    // Only allow listening to public topics
    throw new Error('Unauthorized binding key');
  }
  return header;
};

// Add timestamps to all published messages
const timestampHook = async (header, context, rmqMessage) => {
  return { ...header, timestamp: Date.now() };
};

const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080
});

// Register hooks using addHook method
server.addHook('pre', authHook);           // Runs before all actions
server.addHook('listen', authzHook);       // Runs only for listen actions
server.addHook('publish', timestampHook);  // Runs only for publish actions

await server.start();
```

**Hook Types:**

- **`pre`**: Runs before all other hooks
- **`wsMessage`**: Runs for all WebSocket→RabbitMQ messages (publish, listen, unlisten)
- **`publish`**: Runs only for publish actions
- **`listen`**: Runs only for listen actions
- **`unlisten`**: Runs only for unlisten actions
- **`rmqMessage`**: Runs for RabbitMQ→WebSocket messages
- **`post`**: Runs after all other hooks

**Hook Signature:**

```typescript
type HookFunction = (
  header: MessageHeader,
  context: HookContext,
  rmqMessage?: amqplib.ConsumeMessage
) => Promise<MessageHeader>
```

**Parameters:**

- **`header`**: Message header object containing:
  - `routingKey?`: Topic for publish actions
  - `bindingKey?`: Pattern for listen/unlisten actions
  - `rmqOptions?`: RabbitMQ publish options
  - Custom properties you add
- **`context`**: Contains `socket` (Socket.IO socket), `sessionId`, and any custom properties
- **`rmqMessage`**: Only provided for `rmqMessage` hooks, contains the raw RabbitMQ message

Hooks run in sequence and can modify the header. Throwing an error aborts the action.

### Client-Side Hooks

Frontend hooks are synchronous functions that transform message headers before they're sent.

```javascript
import WebMQClient from 'webmq-frontend';

// Add authentication token to all messages
const authHook = (header) => {
  return { ...header, token: sessionStorage.getItem('authToken') };
};

// Log all published messages
const loggingHook = (header) => {
  console.log('Publishing:', header.routingKey);
  return header;
};

// Transform incoming messages
const transformHook = (header) => {
  return { ...header, receivedAt: Date.now() };
};

const client = new WebMQClient({
  url: 'ws://localhost:8080',
  sessionId: crypto.randomUUID()
});

// Register hooks using addHook method
client.addHook('pre', loggingHook);      // Runs before all actions
client.addHook('publish', authHook);     // Runs only for publish
client.addHook('message', transformHook); // Runs for incoming messages

client.connect();
```

**Hook Types:**

- **`pre`**: Runs before all other hooks
- **`publish`**: Runs only for publish actions
- **`listen`**: Runs only for listen actions
- **`unlisten`**: Runs only for unlisten actions
- **`message`**: Runs for incoming messages from RabbitMQ
- **`post`**: Runs after all other hooks

**Hook Signature:**

```typescript
type HookFunction<T extends MessageHeader> = (header: T) => T
```

Hooks receive a header object and must return a (possibly modified) header. Throwing an error will abort the action.

### Logging Configuration

Both frontend and backend support configurable logging levels:

```javascript
// Frontend
const client = new WebMQClient({
  url: 'ws://localhost:8080',
  sessionId: crypto.randomUUID(),
  logLevel: 'DEBUG'  // 'SILENT' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG'
});

// Backend
const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080,
  logLevel: 'INFO'  // 'SILENT' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG'
});
```

### Connection Events

The WebMQClient proxies Socket.IO events for connection monitoring:

```javascript
const client = new WebMQClient({
  url: 'ws://localhost:8080',
  sessionId: crypto.randomUUID()
});

client.connect();

// Socket.IO connection events
client.on('connect', () => console.log('Connected'));
client.on('disconnect', () => console.log('Disconnected'));
client.on('connect_error', (error) => console.log('Connection error:', error));
```

Available events: `connect`, `disconnect`, `connect_error`, `reconnect`, `reconnect_attempt`, `reconnecting`, `reconnect_error`, `reconnect_failed`

**Note:** The backend WebMQServer does not emit custom events. Use the logging system or Prometheus metrics for monitoring.

### Health Check & Metrics

WebMQ provides built-in HTTP endpoints for health checks and Prometheus metrics. When you specify `healthEndpoint` or `metricsEndpoint`, the backend automatically creates an HTTP server that handles these routes.

```javascript
const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080,
  host: '0.0.0.0',
  healthEndpoint: '/health',    // Creates health check at http://localhost:8080/health
  metricsEndpoint: '/metrics'   // Creates metrics at http://localhost:8080/metrics
});

await server.start();
```

**Health Check Response:**

```json
{
  "healthy": true,
  "rabbitMQQueues": 5,
  "websockets": 12
}
```

Returns HTTP 200 when healthy, 503 when unhealthy (RabbitMQ connection failures).

**Metrics Endpoint:**

Returns Prometheus-formatted metrics including:
- WebSocket connections
- RabbitMQ consumer count
- Messages published/acked
- Binding key counts
- Error counts by type

### Prometheus Metrics

WebMQ exposes Prometheus metrics for monitoring:

**Available Metrics:**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `webmq_ws_connections` | Gauge | - | Active WebSocket connections |
| `webmq_rmq_consumers` | Gauge | - | Active RabbitMQ consumers |
| `webmq_rmq_bindings` | Gauge | `binding_key` | Active queue bindings by pattern |
| `webmq_rmq_consecutive_failures` | Gauge | - | Consecutive RabbitMQ connection failures |
| `webmq_ws_messages_received` | Counter | `action` | Messages received from WebSocket clients |
| `webmq_ws_to_rmq_publishes` | Counter | `routing_key` | Messages published to RabbitMQ |
| `webmq_rmq_messages_acked` | Counter | `routing_key` | Messages acknowledged from RabbitMQ |
| `webmq_errors` | Counter | `type`, `action` | Errors by type and action |

**Prometheus Configuration:**

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'webmq'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:8080']
```

## Features

- **Guaranteed message delivery**: Backend waits for client acknowledgment before acking RabbitMQ, preventing message loss
- **Auto-reconnection**: Fast reconnection with configurable delays (default 500ms-2s)
- **Graceful shutdowns**: Proper cleanup of connections, queues, and resources
- **Flexible hooks**: Transform message headers on both frontend and backend
- **Topic wildcards**: Subscribe to event patterns with `*` (single segment) and `#` (multiple segments)
- **Connection events**: Monitor connection state via Socket.IO events
- **Framework agnostic**: Works with React, Vue, Angular, React Native, or vanilla JS
- **TypeScript support**: Full type definitions with JsonSerializable types
- **Health & metrics**: Built-in health checks and Prometheus metrics
- **Per-session queues**: Each client gets a dedicated RabbitMQ queue with configurable TTL

## API Reference

### Frontend API

#### WebMQClient Class

WebMQ uses a class-based client that you instantiate for each connection:

```javascript
import WebMQClient from 'webmq-frontend';

const client = new WebMQClient({
  url: 'ws://localhost:8080',
  sessionId: crypto.randomUUID(),
  logLevel: 'INFO'
});

client.connect();
```

Multiple clients can be created to connect to different backends:

```javascript
const chatClient = new WebMQClient({ 
  url: 'ws://chat.example.com', 
  sessionId: 'chat-' + crypto.randomUUID() 
});
const analyticsClient = new WebMQClient({ 
  url: 'ws://analytics.example.com',
  sessionId: 'analytics-' + crypto.randomUUID()
});
```

**Constructor:**

```typescript
new WebMQClient(options: WebMQClientOptions)
```

Options:

- `url` (string, **required**): WebSocket server URL (e.g., 'ws://localhost:8080')
- `sessionId` (string, **required**): Unique session identifier (used for RabbitMQ queue name)
- `logLevel` (LogLevel, optional): 'SILENT' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' (default: 'INFO')

**Methods:**

- `connect(): void` - Establish WebSocket connection
  - Must be called before publish/listen
  - Auto-reconnects on disconnect with 500ms-2s delays

- `disconnect(): void` - Close WebSocket connection
  - Cleans up listeners but preserves client state

- `publish(routingKey: string, payload: ArrayBuffer | JsonSerializable): void` - Publish message
  - `routingKey`: Topic to publish to (e.g., 'chat.room.1')
  - `payload`: Either binary data (ArrayBuffer) or JSON-serializable object
  - JSON objects are automatically stringified and encoded

- `listen(bindingKey: string, callback: (payload: JsonSerializable) => void, isJson?: true): void` - Subscribe to JSON messages (default)
  - `bindingKey`: Topic pattern (supports `*` for single segment, `#` for multiple segments)
  - `callback`: Handler receiving parsed JSON payload
  - Payloads are automatically decoded and parsed

- `listen(bindingKey: string, callback: (payload: ArrayBuffer) => void, isJson: false): void` - Subscribe to binary messages
  - `callback`: Handler receiving raw ArrayBuffer payload

- `listenJson(bindingKey: string, callback: (payload: JsonSerializable) => void): void` - Subscribe to JSON messages (alias)

- `listenRaw(bindingKey: string, callback: (payload: ArrayBuffer) => void): void` - Subscribe to binary messages (alias)

- `unlisten(bindingKey: string, callback: Function): void` - Unsubscribe from events
  - Removes specific callback for the binding key
  - Backend is notified when last callback is removed

- `addHook(hookName: HookName, hookFunction: HookFunction): void` - Add message transformation hook
  - See [Client-Side Hooks](#client-side-hooks) for details

- `removeHook(hookName: HookName, hookFunction: HookFunction): void` - Remove hook

- `on(...args): void` - Listen to Socket.IO events (proxied to internal socket)
  - `'connect'`, `'disconnect'`, `'connect_error'`, `'reconnect'`, etc.

- `off(...args): void` - Remove Socket.IO event listener

**Properties:**

- `url` (string, readonly): WebSocket server URL
- `sessionId` (string, readonly): Session identifier
- `logLevel` (LogLevel): Control logging verbosity

### Backend API

#### WebMQServer Class

**Constructor:**

```typescript
new WebMQServer(options: WebMQServerOptions)
```

Options:

- `rmqUrl` (string, **required**): AMQP connection URL (e.g., 'amqp://localhost' or 'amqp://user:pass@host:5672')
- `exchange` (string, **required**): RabbitMQ exchange name (always created as durable topic exchange)
- `port` (number, **required**): Port to listen on for HTTP and WebSocket server
- `host` (string, optional): Host to bind to (default: all interfaces)
- `healthEndpoint` (string, optional): HTTP path for health checks (e.g., '/health')
- `metricsEndpoint` (string, optional): HTTP path for Prometheus metrics (e.g., '/metrics')
- `queueTimeout` (number, optional): Queue TTL in milliseconds (default: 300000 = 5 minutes)
  - Client queues are automatically deleted if unused for this duration
- `logLevel` (LogLevel, optional): 'SILENT' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG' (default: 'INFO')

**Methods:**

- `start(): Promise<void>` - Start server
  - Connects to RabbitMQ and creates exchange
  - Starts HTTP server (for WebSocket upgrade, health, and metrics)
  - Starts Socket.IO server with ping/pong for fast disconnect detection
  - Registers graceful shutdown handlers for SIGTERM and SIGINT

- `stop(): Promise<void>` - Stop server gracefully
  - Stops receiving new messages
  - Waits for in-flight messages to complete
  - Cancels all RabbitMQ consumers
  - Closes WebSocket connections
  - Closes RabbitMQ channels and connections

- `addHook(hookName: HookName, hookFunction: HookFunction): void` - Add message transformation hook
  - See [Server-Side Hooks](#server-side-hooks) for details

- `removeHook(hookName: HookName, hookFunction: HookFunction): void` - Remove hook

**Properties:**

- `logLevel` (LogLevel): Control logging verbosity

**Examples:**

Basic setup:

```javascript
import WebMQServer from 'webmq-backend';

const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080,
  healthEndpoint: '/health',
  metricsEndpoint: '/metrics'
});

await server.start();
```

With hooks:

```javascript
const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080
});

server.addHook('publish', async (header, context) => {
  return { ...header, timestamp: Date.now() };
});

await server.start();
```

## Roadmap

### Recently Completed ✅

- TypeScript support with full type definitions
- Guaranteed message delivery (client acknowledgment before RabbitMQ ack)
- Fast disconnect detection (2s ping interval, 5s timeout)
- React Native support with Blob compatibility fixes
- Built-in Prometheus metrics and health checks
- Binary (ArrayBuffer) and JSON message support with type-safe overloads

### Immediate Improvements

1. **Developer Experience**
   - Better error messages and error handling
   - More example apps (collaborative editing, notifications)
   - Better authentication examples with OAuth/JWT

2. **Performance**
   - Message batching to reduce overhead
   - Optional compression for large payloads
   - Connection pooling for RabbitMQ channels

3. **Testing**
   - End-to-end test suite
   - Load testing and benchmarks
   - Integration test helpers

### Bigger Features

4. **Advanced Patterns**
   - Message persistence/replay (RabbitMQ queue durability options)
   - Priority queues
   - Dead letter queues for failed messages

5. **Security**
   - Rate limiting per client/session
   - Message size limits
   - Built-in auth middleware (JWT validation, session management)

6. **Observability**
   - Distributed tracing (OpenTelemetry)
   - Custom metric labels/dimensions
   - Structured logging with correlation IDs

### Nice to Have

7. **Framework Integrations**
   - React hooks package (`useWebMQ`, `usePublish`, `useListen`)
   - Vue composables
   - Next.js API routes example
   - SvelteKit integration

8. **Alternative Backends**
   - Redis Pub/Sub backend
   - In-memory backend for testing (no RabbitMQ required)
   - NATS backend

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
├── backend/     # Node.js Socket.IO + RabbitMQ server library
└── frontend/    # Framework-agnostic client library (browser & React Native)
examples/
├── basic-chat/  # Simple chat application (React web)
├── mobile-chat/ # Mobile chat application (React Native)
├── city-search/ # City search with autocomplete
└── todos/       # Todo list application
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
