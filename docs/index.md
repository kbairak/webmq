# WebMQ

**Your frontend, plugged into RabbitMQ.**

WebMQ is a real-time messaging framework that bridges web frontends with RabbitMQ through WebSockets. It turns browser-side code into a first-class participant in your event-driven architecture.

## Why WebMQ?

Traditional web apps are built on request-response: frontend asks, backend answers. This works for CRUD, but crumbles for live chat, collaborative editing, real-time dashboards, or any feature where the server needs to push data as it happens.

Event-driven architecture flips the model — apps react to events as they occur. But connecting browsers directly to your message broker isn't practical. WebMQ solves this:

- **Frontends publish** to RabbitMQ topic exchanges
- **Frontends subscribe** to topics with wildcard patterns
- **Backend services** in any language process events via AMQP
- **Horizontal scaling** is free — add backend instances, RabbitMQ balances the load

The result: your JavaScript frontend becomes a full citizen in your distributed event system, not a second-class citizen behind REST APIs.

## Features

- **Auto-reconnection** — infinite retry with capped exponential backoff, configurable delays
- **Heartbeat & half-open detection** — application-level ping/pong on the client, WebSocket ping/pong on the server. Zombie connections detected and purged in seconds
- **Message acknowledgments** — promise-based publish/listen/unlisten with server ACK. End-to-end ACK from RabbitMQ to client (server withholds `channel.ack` until client confirms receipt)
- **Offline queuing** — messages sent while disconnected are queued, preserved across reconnects, sent with original message IDs
- **Session dedup** — server evicts stale consumers when a session reconnects, preventing duplicate delivery
- **Middleware hooks** — Express-style hooks on both server and client for auth, logging, payload transformation
- **Topic wildcards** — `*` matches one segment, `#` matches multiple segments
- **Framework agnostic** — works with React, Vue, Angular, vanilla JS, React Native
- **Cross-language workers** — any language with an AMQP library (Python, Go, Java, Ruby, .NET) can process WebMQ events
- **Observability** — built-in health checks and Prometheus metrics
- **Browser lifecycle-aware** — detects `online`/`visibilitychange` to trigger early reconnect

## Quick peek

**Backend** (Node.js):

```javascript
import WebMQServer from 'webmq-backend';

const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080
});
await server.start();
```

**Frontend** (any framework):

```javascript
import WebMQClient from 'webmq-frontend';

const client = new WebMQClient({ url: 'ws://localhost:8080', sessionId: 'user-123' });
client.connect();
client.publish('chat.message', { text: 'Hello from WebMQ!' });
client.listen('chat.message.*', (msg) => console.log('Received:', msg));
```

**Worker** (Python):

```python
import asyncio, aio_pika, json

async def main():
    conn = await aio_pika.connect_robust("amqp://localhost")
    channel = await conn.channel()
    exchange = await channel.get_exchange("my_app")
    queue = await channel.declare_queue(exclusive=True)
    await queue.bind(exchange, "tasks.*")
    async with queue.iterator() as iter:
        async for msg in iter:
            async with msg.process():
                print("Got:", json.loads(msg.body))

asyncio.run(main())
```

---

Ready to dive in? Head to [Getting Started](getting-started.md) to build your first WebMQ app in under 30 lines.
