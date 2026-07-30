# Hooks & Middleware

WebMQ provides Express-style middleware hooks on both the server and client for intercepting and transforming messages.

## Server-side hooks

Hooks run at specific points in the message lifecycle. Each hook receives the message header, a context object, and (for RMQ messages) the raw AMQP message.

### Hook types

| Hook | Runs when |
|---|---|
| `pre` | Before every action |
| `wsMessage` | After `pre`, before action-specific hook |
| `identify` | Client identifies itself |
| `publish` | Client publishes a message |
| `listen` | Client subscribes to a topic |
| `unlisten` | Client unsubscribes |
| `rmqMessage` | RabbitMQ delivers a message to a client |
| `post` | After action-specific hook |

### Hook signature

```typescript
type HookFunction = (
  header: MessageHeader,
  context: HookContext,
  rmqMessage?: amqplib.ConsumeMessage
) => Promise<MessageHeader>;
```

Return the (possibly modified) header. Throw to abort the action.

### Adding hooks

```javascript
import WebMQServer from 'webmq-backend';

const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'secure_app',
  port: 8080
});

// Authentication — reject unauthenticated requests
server.addHook('wsMessage', async (header, context) => {
  if (header.action === 'identify') {
    const { token } = header;
    if (!token) throw new Error('Authentication required');
    context.user = await verifyToken(token);
  }
  return header;
});

// Authorization — restrict listen to user-specific topics
server.addHook('listen', async (header, context) => {
  if (!header.bindingKey.endsWith(context.user.id)) {
    throw new Error('Cannot listen to other users events');
  }
  return header;
});

// Payload enrichment — add metadata to every publish
server.addHook('publish', async (header, context) => {
  header.payload = {
    ...header.payload,
    userId: context.user.id,
    timestamp: Date.now()
  };
  return header;
});

await server.start();
```

### Auth example

A complete auth flow using hooks on both server and client:

**Server:**

```javascript
server.addHook('identify', async (header, context) => {
  const { token } = header;
  if (!token) throw new Error('Token required');
  context.user = await jwt.verify(token, SECRET);
  return header;
});

server.addHook('publish', async (header, context) => {
  if (!context.user) throw new Error('Not authenticated');
  header.payload.userId = context.user.id;
  return header;
});
```

**Client:**

```javascript
client.addHook('identify', (header) => {
  header.token = localStorage.getItem('jwt');
  return header;
});
```

## Client-side hooks

Client hooks are **synchronous** header transformers — modify and return the header.

### Hook types

| Hook | Runs when |
|---|---|
| `pre` | Before every action |
| `identify` | Before sending identify message |
| `publish` | Before publishing |
| `listen` | Before subscribing |
| `unlisten` | Before unsubscribing |
| `message` | When receiving a message from the server |
| `post` | After action-specific hook |

### Hook signature

```typescript
type HookFunction<T extends MessageHeader> = (header: T) => T;
```

Return the modified header. Returning `undefined` or throwing will abort the action.

### Adding hooks

```javascript
import WebMQClient from 'webmq-frontend';

const client = new WebMQClient({
  url: 'ws://localhost:8080',
  sessionId: crypto.randomUUID()
});

// Logging
client.addHook('pre', (header) => {
  console.log('Processing:', header.action);
  return header;
});

// Decrypt incoming messages
client.addHook('message', (header) => {
  if (header.payload?.encrypted) {
    header.payload.data = decrypt(header.payload.encrypted);
    delete header.payload.encrypted;
  }
  return header;
});

// Add auth token to identify
client.addHook('identify', (header) => {
  header.token = sessionStorage.getItem('authToken');
  return header;
});

client.connect();
```

### Removing hooks

```javascript
const logHook = (header) => {
  console.log('Processing:', header.action);
  return header;
};

client.addHook('pre', logHook);
// ...
client.removeHook('pre', logHook);
```

## Context object

The `context` object on the **server** persists across all messages from the same WebSocket connection:

```javascript
const sessionHook = async (header, context) => {
  if (!context.sessionStartTime) {
    context.sessionStartTime = Date.now();
  }
  // Available in all subsequent hook calls for this connection
  return header;
};

server.addHook('pre', sessionHook);
```

On the client, you can use closures or module-level variables instead — the `context` parameter does not exist in client hooks since they are synchronous transformers.
