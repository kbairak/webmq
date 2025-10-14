# WebMQ

A real-time messaging framework that bridges web frontends with RabbitMQ using WebSockets for event-driven architecture.

## Why WebMQ?

Traditional web applications rely on request-response patterns where the client asks for data and waits for a reply. This works well for CRUD operations but falls short for real-time features like live chat, collaborative editing, or status updates. Event-driven development flips this model: applications react to events as they happen, enabling truly responsive user experiences.

While WebSocket libraries exist, WebMQ leverages RabbitMQ's battle-tested message routing, persistence, and clustering capabilities. This means your real-time features inherit decades of messaging reliability. When you need to scale horizontally, simply spin up more backend instances—RabbitMQ handles message distribution seamlessly across your infrastructure.

**You can use WebMQ as a replacement for Socket.IO, but with horizontal scaling naturally supported. But** the real power is making the frontend part of a mature distributed event-driven system. When the frontend publishes a message, any backend service out of hundreds can pick it up and process it. Similarly, the frontend can subscribe to events from any service in your infrastructure.

## Quick Start

Here's a complete real-time chat in under 30 lines:

**Backend** (`server.js`):

```javascript
import { WebMQServer } from 'webmq-backend';

const webMQServer = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'chat_app',
  port: 8080
});

await webMQServer.start();
console.log('WebMQ server running on ws://localhost:8080');
```

**Frontend** (React component):

```jsx
import { setup, listen, unlisten, publish } from 'webmq-frontend';
import { useState, useEffect, useCallback } from 'react';

setup({ url: 'ws://localhost:8080' });

export default function Chat() {
  const username = useRef(randomName());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  const onMessageAdded = useCallback((msg) => { setMessages((prev) => [...prev, msg]); }, []);
  useEffect(() => {
    listen('chat.messages', onMessageAdded);
    return () => unlisten('chat.messages', onMessageAdded);
  }, [onMessageAdded]);

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

WebMQ uses Express-style middleware hooks to intercept and process messages on the backend. Each hook receives a `context` (connection data), `next` function, and `message` (the client request). Call `await next()` to continue to the next hook, return without calling `next` to abort silently, or throw an error to reject the request.

```javascript
// Authentication hook
const authenticationHook = async (context, next, message) => {
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
const authorizationHook = async (context, next, message) => {
  if (message.action === 'listen') {
    const userUUID = context.user.id;
    if (!message.bindingKey.endsWith(userUUID)) {
      throw new Error('Cannot listen to events for other users');
    }
  }

  await next();
};

// Payload enhancement hook - add user ID to all published messages
const payloadEnhancementHook = async (context, next, message) => {
  if (message.action === 'publish') {
    message.payload.userId = context.user.id;
    message.payload.timestamp = Date.now();
  }

  await next();
};

const webMQServer = new WebMQServer({
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

Each hook receives three parameters:

- **`context`**: Persistent object containing `ws` (the WebSocket connection object) and `sessionId` (the session ID, set after identify action). Hooks can add custom properties to store user data or other state across requests.
- **`next`**: Function to continue to the next hook or main action
- **`message`**: Action-specific data containing:
  - `action`: The type of action ('identify', 'publish', 'listen', 'unlisten')
  - `routingKey`: Topic being published to (publish actions)
  - `payload`: Message data (publish, identify actions)
  - `bindingKey`: Topic pattern being listened to (listen, unlisten actions)
  - `sessionId`: Session identifier (identify actions)
  - `messageId`: A unique ID for this message (all actions)

### Client-Side Hooks

WebMQ also supports middleware-style hooks on the frontend to intercept and process messages before they're sent or received. Client-side hooks follow the exact same Express-style pattern as backend hooks, using `context`, `next()`, and `message` parameters.

```javascript
import { setup } from 'webmq-frontend';

// Authentication hook - add JWT token to identify message
const authenticationHook = async (context, next, message) => {
  message.payload = { token: sessionStorage.getItem('authToken') };
  await next();
};

// Logging hook - track all messages
const loggingHook = async (context, next, message) => {
  console.log('Processing:', message.action, message.routingKey || message.bindingKey);
  await next();
};

// Message transformation hook - decrypt incoming messages
const decryptionHook = async (context, next, message) => {
  if (message.payload && message.payload.encrypted) {
    message.payload.data = decrypt(message.payload.encrypted);
    delete message.payload.encrypted;
  }
  await next();
};

setup({
  url: 'ws://localhost:8080', 
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

Each hook receives three parameters:

- **`context`**: Persistent object containing `client` reference and user data
- **`next`**: Function to continue to the next hook or main action
- **`message`**: Action-specific data containing:
  - `action`: The type of action ('publish', 'listen', 'message')
  - `routingKey`: Topic being published to (publish actions)
  - `payload`: Message data (publish, message actions)
  - `bindingKey`: Topic pattern being listened to (listen, message actions)
  - `callback`: Message handler function (listen actions)

The context persists across different actions, allowing hooks to maintain state:

```javascript
const sessionHook = async (context, next, message) => {
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
const webMQServer = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  port: 8080
});
webMQServer.logLevel = 'info';
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

**Note:** The backend WebMQServer does not currently emit custom events. For backend monitoring, use the built-in logging system by setting `server.logLevel = 'debug'` or Prometheus metrics integration.

### Health Check & Metrics

WebMQ provides built-in support for health check and Prometheus metrics endpoints. There are three ways to set them up depending on your architecture.

#### Pattern 1: Automatic Setup (Standalone Mode)

When using `port` without an external HTTP server, WebMQ creates and manages the HTTP server automatically, setting up routing for you.

```javascript
const webMQServer = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  port: 8080,
  healthCheck: true,  // Creates /health endpoint
  metrics: true       // Creates /metrics endpoint
});
await webMQServer.start();

// Endpoints available at:
// - http://localhost:8080/health
// - http://localhost:8080/metrics
```

**Custom paths:**

```javascript
const webMQServer = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  port: 8080,
  healthCheck: '/api/health',  // Custom health endpoint
  metrics: '/prometheus'        // Custom metrics endpoint
});
```

#### Pattern 2: Manual Routing (External HTTP Server)

When passing an external HTTP server via `server` option, you must manually wire up the endpoint handlers. This gives you full control over routing and middleware.

```javascript
import { createServer } from 'http';

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    webMQServer.healthCheckHandler(req, res);
  } else if (req.url === '/metrics') {
    webMQServer.metricsHandler(req, res);
  } else {
    res.writeHead(426);
    res.end('Upgrade Required');
  }
});

const webMQServer = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  server: httpServer
});

await webMQServer.start();
httpServer.listen(8080);
```

#### Pattern 3: Express Integration

The most common production setup uses Express for routing, middleware, and additional endpoints.

```javascript
import express from 'express';
import { createServer } from 'http';

const app = express();
const httpServer = createServer(app);

const webMQServer = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  server: httpServer
});

// Add endpoints with middleware
app.get('/health', webMQServer.healthCheckHandler);
app.get('/metrics', authMiddleware, webMQServer.metricsHandler);

// Additional REST endpoints
app.get('/api/stats', (req, res) => {
  res.json({ uptime: process.uptime() });
});

await webMQServer.start();
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

Returns HTTP 200 when healthy, 503 when unhealthy.

### Prometheus Metrics

WebMQ exposes Prometheus metrics for monitoring message throughput, latency, connections, and errors.

**Available Metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `webmq_connections_active` | Gauge | Current active WebSocket connections |
| `webmq_rabbitmq_connected` | Gauge | RabbitMQ connection status (0=disconnected, 1=connected) |
| `webmq_subscriptions_active` | Gauge | Current active subscriptions |
| `webmq_messages_published_total` | Counter | Total messages published to RabbitMQ |
| `webmq_messages_received_total` | Counter | Total messages received from RabbitMQ |
| `webmq_errors_total{type}` | Counter | Total errors by type (rabbitmq_connection, websocket_error) |
| `webmq_publish_duration_seconds` | Histogram | Time to publish message to RabbitMQ |
| `webmq_messages_by_routing_key{routing_key}` | Counter | Messages published per routing key |
| `webmq_subscriptions_by_binding_key{binding_key}` | Gauge | Subscriptions per binding key |

**Prometheus Configuration:**

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'webmq'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:8080']
```

**Grafana Dashboard Example:**

```promql
# Messages per second
rate(webmq_messages_published_total[1m])

# Average publish latency
rate(webmq_publish_duration_seconds_sum[5m]) / rate(webmq_publish_duration_seconds_count[5m])

# 95th percentile latency
histogram_quantile(0.95, rate(webmq_publish_duration_seconds_bucket[5m]))

# Active connections over time
webmq_connections_active

# Error rate
rate(webmq_errors_total[5m])
```

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
// Option 1: Using standalone functions (most common)
import { setup, listen, publish, unlisten } from 'webmq-frontend';
setup({ url: 'ws://localhost:8080' });

// Option 2: Direct client instantiation
import { WebMQClient } from 'webmq-frontend';
const client = new WebMQClient({ url: 'ws://localhost:8080' });

// Option 3: Create then configure
const client = new WebMQClient({});
client.setup({ url: 'ws://localhost:8080' });
```

For advanced features like logging or event monitoring, you can either create a custom instance or import the singleton. See [Logging Configuration](#logging-configuration) and [EventEmitter Events](#eventemitter-events) in Core Concepts.

Multiple clients can be created to connect to different backends:

```javascript
const chatClient = new WebMQClient({ url: 'ws://chat.example.com' });
const analyticsClient = new WebMQClient({ url: 'ws://analytics.example.com' });
```

#### WebMQClient Class

**Constructor:**

```typescript
new WebMQClient(options: WebMQClientOptions)
```

Options:

- `url` (string, optional): WebSocket server URL (e.g., 'ws://localhost:8080')
- `hooks` (WebMQClientHooks, optional): Client-side middleware hooks
  - `pre` (HookFunction[]): Run before all actions
  - `onIdentify` (HookFunction[]): Run when establishing connection
  - `onPublish` (HookFunction[]): Run for 'publish' actions
  - `onListen` (HookFunction[]): Run for 'listen' actions
  - `onUnlisten` (HookFunction[]): Run for 'unlisten' actions
  - `onMessage` (HookFunction[]): Run for incoming messages
- `ackTimeoutDelay` (number, optional): Timeout in ms for server acknowledgments (default: 5000)
- `reconnectionDelay` (number, optional): Base delay in ms for exponential backoff (default: 1000)
- `maxReconnectionAttempts` (number, optional): Max reconnection attempts (default: 5)

**Methods:**

- `setup(options: WebMQClientOptions): void` - Configure connection (also available as standalone import)
  - Same options as constructor

- `publish(routingKey: string, payload: any): Promise<void>` - Publish events (also available as standalone import)
  - `routingKey`: Topic to publish to (e.g., 'chat.room.1')
  - `payload`: Data to send (will be JSON stringified)
  - Returns: Promise that resolves on server ACK, rejects on NACK or timeout

- `listen(bindingKey: string, callback: (payload: any) => void): Promise<void>` - Subscribe to events (also available as standalone import)
  - `bindingKey`: Topic pattern (supports `*` for single segment, `#` for multiple segments)
  - `callback`: Handler receiving message payload
  - Returns: Promise that resolves when subscription is confirmed

- `unlisten(bindingKey: string, callback: (payload: any) => void): Promise<void>` - Unsubscribe from events (also available as standalone import)
  - `bindingKey`: Topic pattern to stop listening to
  - `callback`: Specific callback to remove
  - Returns: Promise that resolves when unsubscribed

- `close(): void` - Disconnect and disable reconnection (also available as standalone import)

**Properties:**

- `logLevel` ('silent' | 'error' | 'warn' | 'info' | 'debug'): Control logging verbosity (default: 'info')

**Events (extends EventEmitter):**

- `'connected'`: Initial connection established
- `'disconnected'`: Connection lost and reconnection attempts exhausted
- `'reconnecting'`: Connection attempting to reconnect (event data contains attempt number)
- `'error'`: WebSocket error occurred

```javascript
import { webMQClient } from 'webmq-frontend';
webMQClient.on('connected', () => console.log('Connected'));
webMQClient.on('reconnecting', (attempt) => console.log(`Reconnecting... attempt ${attempt}`));
```

### Backend API

#### WebMQServer Class

**Constructor:**

```typescript
new WebMQServer(options: WebMQServerOptions)
```

Options (extends ws ServerOptions):

- `rabbitmqUrl` (string, **required**): AMQP connection URL (e.g., 'amqp://localhost' or 'amqp://user:pass@host:5672')
- `exchangeName` (string, **required**): RabbitMQ exchange name (always created as durable topic exchange)
- `port` (number, optional): Port to listen on for standalone WebSocket server
- `server` (http.Server | https.Server, optional): Existing HTTP/HTTPS server to attach WebSocket server to
- `healthCheck` (boolean | string, optional): Enable health check endpoint
  - `true`: Automatically creates endpoint at `/health`
  - `'/custom-path'`: Creates endpoint at specified path
  - Works with both standalone (`port`) and attached (`server`) modes
- `metrics` (boolean | string, optional): Enable Prometheus metrics endpoint
  - `true`: Automatically creates endpoint at `/metrics`
  - `'/custom-path'`: Creates endpoint at specified path
  - Exposes metrics in Prometheus text format
- `hooks` (WebMQHooks, optional): Server-side middleware hooks
  - `pre` (HookFunction[]): Run before all actions
  - `onIdentify` (HookFunction[]): Run when client sends identify message
  - `onPublish` (HookFunction[]): Run for 'publish' actions
  - `onListen` (HookFunction[]): Run for 'listen' actions
  - `onUnlisten` (HookFunction[]): Run for 'unlisten' actions
- All other options from [ws ServerOptions](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback) (path, perMessageDeflate, clientTracking, etc.)

**Methods:**

- `start(): Promise<void>` - Start WebSocket server and connect to RabbitMQ
  - Establishes RabbitMQ connection
  - Creates WebSocket server (standalone or attached)
  - Sets up automatic health check endpoint if configured
  - Registers graceful shutdown handlers

- `stop(): Promise<void>` - Stop server and cleanup resources
  - Closes WebSocket server
  - Closes all RabbitMQ channels and connections
  - Removes graceful shutdown handlers

- `healthCheckHandler: (req, res) => void` - Health check handler for manual setup
  - Bound arrow function property (use directly without calling)
  - Useful for integrating with Express or other frameworks
  - Returns HTTP 200 with health status when healthy
  - Returns HTTP 503 when unhealthy (RabbitMQ disconnected or WebSocket stopped)

- `metricsHandler: (req, res) => void` - Prometheus metrics handler for manual setup
  - Bound arrow function property (use directly without calling)
  - Exposes metrics in Prometheus text format (version 0.0.4)
  - Returns HTTP 200 with metrics data

**Properties:**

- `logLevel` ('silent' | 'error' | 'warn' | 'info' | 'debug'): Control logging verbosity (default: 'info')

**Examples:**

Basic standalone mode:

```javascript
const webMQServer = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'my_app',
  port: 8080
});
await webMQServer.start();
```

For health check and metrics setup examples, see the [Health Check & Metrics](#health-check--metrics) section in Core Concepts.

## Roadmap

### Immediate Improvements

1. Production Readiness

- Better error handling in backend (channel errors, connection recovery)
- Graceful degradation when RabbitMQ is down

2. Performance

- Message batching to reduce overhead
- Compression for large payloads

3. Developer Experience

- TypeScript support in examples
- More example apps (notifications, collaborative editing?)
- Better error messages

### Bigger Features

4. Advanced Patterns

- Message persistence/replay
- Priority queues

5. Security

- Rate limiting per client
- Message size limits
- Better authentication examples

6. Observability

- Distributed tracing
- Custom metric labels/dimensions

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
