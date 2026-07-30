# API Reference

## Frontend: `WebMQClient`

```javascript
import WebMQClient from 'webmq-frontend';
```

### Constructor

```typescript
new WebMQClient(options: WebMQClientOptions)
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | — | WebSocket server URL (e.g., `'ws://localhost:8080'`) |
| `sessionId` | `string` | — | Unique session identifier. Used for session queue name and consumer dedup |
| `reconnectDelays` | `number[]` | `[0, 500, 1000, 2000, 3000]` | Reconnection delay sequence (ms). Last value repeats indefinitely |
| `pingInterval` | `number` | `5000` | Client ping interval (ms) |
| `pongTimeout` | `number` | `10000` | Max ms without pong before force-reconnect |
| `ackTimeout` | `number` | `5000` | Max ms waiting for server ACK before promise rejects |
| `logLevel` | `LogLevel` | `'INFO'` | `'DEBUG' \| 'INFO' \| 'WARNING' \| 'ERROR' \| 'SILENT'` |

### Methods

#### `connect(): void`

Open WebSocket connection and start reconnection logic.

```javascript
client.connect();
```

#### `disconnect(): void`

Close WebSocket connection gracefully and stop reconnection.

```javascript
client.disconnect();
```

#### `forceReconnect(): void`

Force immediate reconnection attempt. Useful when you know the connection is stale but the WebSocket hasn't closed yet.

```javascript
client.forceReconnect();
```

#### `publish(routingKey: string, payload: any): Promise<void>`

Publish a message to a routing key. Returns a promise that resolves when the server ACKs.

| Param | Type | Description |
|---|---|---|
| `routingKey` | `string` | Topic to publish to (e.g., `'chat.room.1'`) |
| `payload` | `any` | Data to send. Objects/arrays are JSON-serialized. `ArrayBuffer` sent raw |

```javascript
await client.publish('order.created', { id: 123, total: 49.99 });
```

#### `listen(bindingKey: string, callback: (payload: any) => void, isJson?: boolean): Promise<void>`

Subscribe to messages matching a topic pattern.

| Param | Type | Default | Description |
|---|---|---|---|
| `bindingKey` | `string` | — | Topic pattern (`*` = one segment, `#` = multi-segment) |
| `callback` | `(payload) => void` | — | Handler receiving message payload |
| `isJson` | `boolean` | `true` | Auto-parse payload as JSON before calling callback |

```javascript
await client.listen('orders.*', (order) => console.log(order));
```

#### `listenRaw(bindingKey: string, callback: (payload: ArrayBuffer) => void): Promise<void>`

Subscribe with raw `ArrayBuffer` payload (no JSON parsing).

```javascript
await client.listenRaw('files.upload', (buffer) => processFile(buffer));
```

#### `listenJson(bindingKey: string, callback: (payload: any) => void): Promise<void>`

Explicitly subscribe with JSON parsing (same as `listen` with `isJson: true`).

#### `unlisten(bindingKey: string, callback: (payload: any) => void): Promise<void>`

Remove a specific listener. The queue binding is removed only when no more callbacks remain for that binding key.

```javascript
await client.unlisten('orders.*', myHandler);
```

#### `addHook(action: HookName, hook: HookFunction): void`

Add a middleware hook. See [Hooks & Middleware](hooks.md) for details.

```javascript
client.addHook('identify', (header) => {
  header.token = getToken();
  return header;
});
```

#### `removeHook(action: HookName, hook: HookFunction): void`

Remove a previously added hook.

```javascript
client.removeHook('publish', myHook);
```

### Events

WebMQClient extends `EventTarget`. Use `addEventListener` / `removeEventListener`.

| Event | Detail | When |
|---|---|---|
| `connected` | — | First connection established |
| `disconnected` | — | Connection lost |
| `reconnecting` | `{ attempt }` | About to attempt reconnection |
| `reconnected` | — | Connection restored after reconnect |
| `error` | — | WebSocket error |

```javascript
client.addEventListener('connected', () => console.log('Connected'));
client.addEventListener('reconnecting', (e) =>
  console.log(`Attempt ${e.detail.attempt}`));
```

### Properties

| Property | Type | Default | Description |
|---|---|---|---|
| `logLevel` | `LogLevel` | `'INFO'` | Logging verbosity |
| `reconnectDelays` | `number[]` | as constructor | Current reconnect delay sequence |
| `pingInterval` | `number` | as constructor | Current ping interval |
| `pongTimeout` | `number` | as constructor | Current pong timeout |
| `ackTimeout` | `number` | as constructor | Current ACK timeout |
| `url` | `string` | as constructor | WebSocket URL (readonly) |
| `sessionId` | `string` | as constructor | Session ID (readonly) |

---

## Backend: `WebMQServer`

```javascript
import WebMQServer from 'webmq-backend';
```

### Constructor

```typescript
new WebMQServer(options: WebMQServerOptions)
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `rmqUrl` | `string` | — | AMQP connection URL (e.g., `'amqp://localhost'`) |
| `exchange` | `string` | — | RabbitMQ exchange name (created as durable topic exchange) |
| `port` | `number` | — | Port to listen on |
| `healthEndpoint` | `string` | `'/health'` | Path for health check. Omit to disable |
| `metricsEndpoint` | `string` | `'/metrics'` | Path for Prometheus metrics. Omit to disable |
| `queueTimeout` | `number` | `300000` | Session queue TTL (ms) |
| `wsPingInterval` | `number` | `15000` | Server WebSocket ping interval (ms). Stale sockets terminated |
| `clientAckTimeout` | `number` | `10000` | Max ms to wait for client ACK before requeueing RMQ message |
| `logLevel` | `LogLevel` | `'INFO'` | `'DEBUG' \| 'INFO' \| 'WARNING' \| 'ERROR' \| 'SILENT'` |

### Methods

#### `start(): Promise<void>`

Start the WebSocket server and connect to RabbitMQ.

```javascript
await server.start();
```

#### `stop(): Promise<void>`

Stop the server and clean up all resources.

```javascript
await server.stop();
```

#### `addHook(hookName: HookName, hook: HookFunction): void`

Add a middleware hook. See [Hooks & Middleware](hooks.md).

#### `removeHook(hookName: HookName, hook: HookFunction): void`

Remove a middleware hook.

### Properties

| Property | Type | Default | Description |
|---|---|---|---|
| `logLevel` | `LogLevel` | `'INFO'` | Logging verbosity |

### Health check and metrics handlers

When you need to wire up the handlers yourself (the server automatically wires them when `healthEndpoint`/`metricsEndpoint` are set):

The server creates its own HTTP server internally (the constructor doesn't accept an external server), so in normal use you don't need these.

---

## Log levels

```typescript
type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT';
```

## Hook names

**Frontend:**

```typescript
type HookName = 'pre' | 'identify' | 'publish' | 'listen' | 'unlisten' | 'message' | 'post';
```

**Backend:**

```typescript
type HookName = 'pre' | 'wsMessage' | 'identify' | 'publish' | 'listen' | 'unlisten' | 'rmqMessage' | 'post';
```

## Types

```typescript
// Client → Server message
interface ClientMessageHeader {
  action: 'identify' | 'publish' | 'listen' | 'unlisten';
  messageId?: string;
  sessionId?: string;
  routingKey?: string;
  bindingKey?: string;
  payload?: any;
  [key: string]: any;
}

// Server → Client message
interface ServerMessageHeader {
  action: 'message' | 'ack' | 'nack';
  messageId?: string;
  routingKey?: string;
  payload?: any;
  error?: string;
  [key: string]: any;
}

// Generic message header
interface MessageHeader = ClientMessageHeader | ServerMessageHeader;
```

## Wire protocol

WebMQ uses a custom binary protocol over WebSocket:

1. **4 bytes**: Header length (big-endian unsigned 32-bit integer)
2. **N bytes**: JSON-encoded message header (UTF-8)
3. **Remaining bytes**: Raw payload

This allows efficient transmission of both JSON data and binary payloads in a single WebSocket message.
