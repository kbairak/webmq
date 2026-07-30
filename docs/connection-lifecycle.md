# Connection Lifecycle

WebMQ handles the hard parts of real-time connections so you don't have to.

## Connection states

```
Disconnected ──connect()──> Connecting ──open──> Connected
                            ↑                      │
                            │   forceReconnect()    │ disconnect()
                            │    or network loss    │ or close()
                            └───────────────────────┘
                                Reconnecting
```

## Auto-reconnection

When a WebSocket disconnects unexpectedly, the client automatically retries with capped exponential backoff:

```javascript
const client = new WebMQClient({
  url: 'ws://localhost:8080',
  sessionId: 'my-session',
  reconnectDelays: [0, 500, 1000, 2000, 3000]  // ms, last value repeats
});
```

Default delays: `[0, 500, 1000, 2000, 3000]` — first retry immediate, then 0.5s, 1s, 2s, then every 3s indefinitely.

## Heartbeat & half-open detection

TCP connections can enter a half-open state where neither side detects the failure. WebMQ prevents this with a two-layer heartbeat:

**Client (application-level ping/pong):**

- Sends a ping message every `pingInterval` ms (default 5000)
- If no pong received within `pongTimeout` ms (default 10000), forces reconnect
- `client.pingInterval` and `client.pongTimeout` are configurable

**Server (WebSocket ping/pong):**

- Sets `isAlive = false` on every WebSocket, then sends `ws.ping()`
- If no `pong` response within `wsPingInterval` ms (default 15000), terminates the socket
- `wsPingInterval` is configurable in `WebMQServer` options

```javascript
const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080,
  wsPingInterval: 10000  // Check every 10s, terminate stale after 10s
});
```

## Offline queuing

Messages published while disconnected are queued **in memory** on the client. On reconnect:

1. The client re-sends all queued messages with their original `messageId`
2. The server processes them normally
3. The publish promises resolve or reject based on server ACK

This means your application code can `publish()` without worrying about connection state — the message either goes through immediately or gets queued and sent on reconnect.

```javascript
// This works even while disconnected
client.publish('orders.create', { item: 'widget' });
// Promise resolves when the server ACKs (now or after reconnect)
```

## Session dedup

When a client reconnects with the same `sessionId`, the server:

1. Cancels the old consumer on RabbitMQ (stops delivering messages to the dead connection)
2. Terminates the old WebSocket
3. Creates a new session queue consumer for the new connection

This prevents duplicate message delivery when a client reconnects before the server detects the old connection is dead.

## Browser lifecycle integration

WebMQ hooks into browser events for smarter reconnection:

- **`window.online`** — when the browser regains network connectivity, WebMQ forces an immediate reconnect
- **`visibilitychange`** — when a tab becomes visible again (e.g., user switches back), WebMQ checks connection health and reconnects if needed

This is especially useful for mobile web apps where network connectivity is intermittent and tabs may be backgrounded for extended periods.

## Graceful shutdown

Call `client.disconnect()` when your component unmounts or the user logs out:

```javascript
// Clean disconnect — server deletes the session queue
client.disconnect();

// Or for the server
await server.stop();  // Closes all WebSockets, cancels consumers, closes RMQ
```

The server registers `SIGTERM`/`SIGINT` handlers that call `stop()` on all active `WebMQServer` instances.

## Connection events

`WebMQClient` extends `EventTarget` and dispatches `CustomEvent`s:

| Event | Detail | When |
|---|---|---|
| `connected` | — | First connection established |
| `disconnected` | — | Connection lost and reconnection attempts are ongoing |
| `reconnecting` | `{ attempt }` | About to attempt a reconnection |
| `reconnected` | — | Connection restored after reconnection |
| `error` | — | WebSocket error occurred |

```javascript
client.addEventListener('connected', () => console.log('Connected'));
client.addEventListener('disconnected', () => console.log('Disconnected'));
client.addEventListener('reconnecting', (e) =>
  console.log(`Reconnecting... attempt ${e.detail.attempt}`));
client.addEventListener('reconnected', () => console.log('Reconnected'));
```

## Configuring timeouts

All configurable via `WebMQClient` constructor options or properties:

| Setting | Default | Description |
|---|---|---|
| `pingInterval` | 5000 | Client ping interval (ms) |
| `pongTimeout` | 10000 | Max wait for pong before reconnect (ms) |
| `ackTimeout` | 5000 | Max wait for server ACK (ms) |
| `reconnectDelays` | [0, 500, 1000, 2000, 3000] | Backoff sequence (ms) |

Server-side:

| Setting | Default | Description |
|---|---|---|
| `wsPingInterval` | 15000 | Server ping interval (ms) |
| `clientAckTimeout` | 10000 | Max wait for client ACK before requeue (ms) |
| `queueTimeout` | 300000 | Session queue TTL (ms) |
