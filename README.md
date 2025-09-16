# WebMQ

WebMQ is a framework designed to bridge web frontends with a RabbitMQ message broker. It uses WebSockets to enable real-time, bidirectional communication, allowing frontend applications to easily publish messages and subscribe to topics.

## Features

- **Real-time Communication:** Built on WebSockets for low-latency message passing.
- **Topic-Based Routing:** Uses a RabbitMQ topic exchange by default for flexible pub/sub patterns.
- **Simple Frontend API:** Provides a clean `send`, `listen`, and `unlisten` API for frontend applications.
- **Extensible Backend:** The backend is a library that can be integrated into any Node.js application and extended with middleware-style hooks for authentication, validation, and logging.

## Project Structure

This project is a monorepo managed with `npm` workspaces.

- `packages/`: Contains the core libraries.
  - `webmq-backend/`: The Node.js backend library.
  - `webmq-frontend/`: The framework-agnostic frontend library.
- `examples/`: Contains example applications demonstrating how to use the framework.
  - `basic-chat/`: A simple, real-time chat application.

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- npm (v7+ recommended)
- Docker and Docker Compose

### Development Setup

1. **Start RabbitMQ:**
    From the project root, start a RabbitMQ server using Docker Compose.

    ```bash
    docker-compose up -d
    ```

    The management UI will be available at [http://localhost:15672](http://localhost:15672) (user: `guest`, pass: `guest`).

2. **Install Dependencies:**
    Install all dependencies for all packages and link the local workspaces.

    ```bash
    npm install
    ```

### Running the Example Application

The `basic-chat` example demonstrates a simple real-time chat room.

1. **Start the Backend Server:**
    In a terminal, run the following command from the project root:

    ```bash
    npm run start:backend -w basic-chat
    ```

    This will start the WebMQ backend on `ws://localhost:8080`.

2. **Start the Frontend Application:**
    In a second terminal, run:

    ```bash
    npm run start:frontend -w basic-chat
    ```

    This will start a Vite development server and provide you with a URL to open the chat application in your browser.

Open the URL in multiple browser tabs to see the real-time communication in action.

---

## API Usage

### Frontend (`webmq-frontend`)

The frontend library provides a simple singleton API.

```javascript
import { setup, listen, send, disconnect, client, getQueueSize } from 'webmq-frontend';

// 1. Configure the connection with optional settings
setup('ws://localhost:8080', {
  maxReconnectAttempts: 5,
  maxQueueSize: 100,     // Queue up to 100 messages when offline
  messageTimeout: 10000  // Wait 10s for server acknowledgment
});

const CHAT_TOPIC = 'chat.room.1';

// 2. Listen for connection events
client.on('connect', () => console.log('Connected to WebMQ'));
client.on('disconnect', () => console.log('Disconnected from WebMQ'));
client.on('reconnect', () => console.log('Reconnected to WebMQ'));

// 3. Listen for messages on a topic
listen(CHAT_TOPIC, (payload) => {
  console.log('Received message:', payload);
});

// 4. Send a message to a topic (queued if offline)
send(CHAT_TOPIC, { user: 'Alice', text: 'Hello, world!' });

// 5. Check queue status
console.log(`Messages queued: ${getQueueSize()}`);

// 6. Disconnect (optional - see disconnect options below)
disconnect();
```

### Backend (`webmq-backend`)

The backend is a class that you can integrate into your Node.js application.

```javascript
import { WebMQServer } from 'webmq-backend';

const server = new WebMQServer({
  rabbitmqUrl: 'amqp://guest:guest@localhost:5672',
  exchangeName: 'my_app_exchange',
  // Optional: Add action-specific hooks for auth, validation, etc.
  hooks: {
    onListen: [ myListenHook ],
    onEmit: [ myEmitHook ]
  }
});

server.start(8080).catch(console.error);
```

#### Disconnect Options

The `disconnect()` method provides options for handling active listeners:

```javascript
import { disconnect, listen, unlisten } from 'webmq-frontend';

// Default behavior: ignore disconnect if listeners exist (safest for multi-component apps)
disconnect(); // Does nothing if listeners are active

// Explicit ignore (same as default)
disconnect({ onActiveListeners: 'ignore' });

// Throw error if listeners exist (good for debugging)
disconnect({ onActiveListeners: 'throw' }); // Throws: "Cannot disconnect: X active listeners"

// Force disconnect and clear all listeners (destructive)
disconnect({ onActiveListeners: 'clear' }); // Clears listeners and disconnects

// Recommended pattern for clean component cleanup
const callback = (payload) => console.log(payload);
listen('topic', callback);
// Later...
unlisten('topic', callback); // Remove specific listener
disconnect(); // Safe to disconnect now
```

**Multi-Component Safety:** The default `'ignore'` behavior prevents components from accidentally breaking each other's listeners in large applications.

#### Connection State Events

WebMQ extends Node.js EventEmitter to provide connection state events. This allows your application to react to connection changes:

```javascript
import { client } from 'webmq-frontend';

// Listen for connection events
client.on('connect', () => {
  console.log('Connected to WebMQ server');
  updateUIStatus('connected');
});

client.on('disconnect', () => {
  console.log('Lost connection to WebMQ server');
  updateUIStatus('disconnected');
});

client.on('reconnect', () => {
  console.log('Successfully reconnected to WebMQ server');
  updateUIStatus('reconnected');
  showNotification('Connection restored');
});

// Remove event listeners when no longer needed
const handler = () => console.log('Connected!');
client.on('connect', handler);
client.off('connect', handler); // Clean removal
```

**Event Types:**

- **`connect`**: Fired on initial successful connection
- **`disconnect`**: Fired when connection is lost
- **`reconnect`**: Fired when connection is re-established after being lost

**React Example:**

```jsx
import { useEffect, useState } from 'react';
import { client } from 'webmq-frontend';

export function ConnectionStatus() {
  const [status, setStatus] = useState('disconnected');

  useEffect(() => {
    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');
    const onReconnect = () => setStatus('reconnected');

    client.on('connect', onConnect);
    client.on('disconnect', onDisconnect);
    client.on('reconnect', onReconnect);

    return () => {
      client.off('connect', onConnect);
      client.off('disconnect', onDisconnect);
      client.off('reconnect', onReconnect);
    };
  }, []);

  return <div className={`status-${status}`}>Status: {status}</div>;
}
```

#### Message Queuing for Offline Support

WebMQ automatically queues messages when disconnected and sends them when the connection is restored. This ensures no messages are lost during network interruptions.

```javascript
import { setup, send, getQueueSize, clearQueue, client } from 'webmq-frontend';

// Configure queue size (default: 100 messages)
setup('ws://localhost:8080', {
  maxQueueSize: 50  // Queue up to 50 messages when offline
});

// Send messages - they'll be queued if offline
send('chat.message', { text: 'This will be queued if offline' });
send('user.action', { action: 'click', button: 'submit' });

// Monitor queue status
console.log(`Queued messages: ${getQueueSize()}`);

// Clear queue if needed (e.g., user logs out)
clearQueue();

// Listen for reconnection to know when queued messages are sent
client.on('reconnect', () => {
  console.log('Reconnected - queued messages have been sent');
});
```

**Queue Behavior:**

- **FIFO ordering**: Messages are sent in the order they were queued
- **Size limits**: Configurable via `maxQueueSize` option (default: 100)
- **Overflow handling**: When full, oldest messages are dropped to make room
- **Automatic flushing**: All queued messages are sent immediately upon reconnection
- **Memory efficient**: Queue is cleared after successful transmission

**Use Cases:**

- **Chat applications**: Don't lose messages during brief disconnections
- **Form submissions**: Queue critical data when offline
- **Analytics events**: Ensure user interactions are captured even with poor connectivity
- **Real-time games**: Buffer player actions during lag spikes

#### Message Acknowledgments

WebMQ provides reliable message delivery through mandatory acknowledgments. Every message sent returns a Promise that resolves when the server confirms delivery to RabbitMQ or rejects on failure.

```javascript
import { send } from 'webmq-frontend';

try {
  // Promise resolves when server confirms delivery
  await send('payment.process', {
    amount: 100,
    currency: 'USD'
  });
  console.log('Payment processed successfully');
} catch (error) {
  console.error('Payment failed:', error.message);
  // Handle failure: retry, show user error, etc.
}
```

**Acknowledgment Behavior:**

- **Automatic**: All messages require acknowledgment (no opt-out)
- **Promise-based**: Simple async/await or .then()/.catch() patterns
- **Timeout protection**: Configurable timeout (default: 10 seconds)
- **Error handling**: Server rejections and timeouts throw descriptive errors

**Server Response Protocol:**

```javascript
// Client sends:
{
  action: 'emit',
  routingKey: 'user.action',
  payload: { action: 'click' },
  messageId: 'msg_1234567890_abc123'
}

// Server responds with:
{ type: 'ack', messageId: 'msg_1234567890_abc123', status: 'success' }
// or
{ type: 'nack', messageId: 'msg_1234567890_abc123', error: 'Validation failed' }
```

**Error Scenarios:**

- **Server rejection**: Business logic errors, validation failures
- **Timeout**: Server doesn't respond within `messageTimeout`
- **Queue overflow**: Message dropped when offline queue is full
- **Network errors**: Connection lost during transmission

**Best Practices:**

```javascript
// Handle specific error types
try {
  await send('order.create', orderData);
} catch (error) {
  if (error.message.includes('timeout')) {
    // Retry logic for timeouts
    showRetryDialog();
  } else if (error.message.includes('validation')) {
    // Show user input errors
    showValidationErrors(error);
  } else {
    // Generic error handling
    showErrorNotification('Order failed');
  }
}

// Batch operations with error handling
const messages = [
  { topic: 'analytics.click', data: { button: 'submit' } },
  { topic: 'user.action', data: { page: 'checkout' } }
];

const results = await Promise.allSettled(
  messages.map(msg => send(msg.topic, msg.data))
);

// Check which succeeded/failed
results.forEach((result, index) => {
  if (result.status === 'rejected') {
    console.warn(`Message ${index} failed:`, result.reason);
  }
});
```

### Authentication

Since WebSockets do not use traditional HTTP headers for every request, authentication must be handled using messages. The recommended approach is to have the client send an `auth` message immediately after connecting.

An authentication hook on the backend can then verify the client's token and attach a user identity to the connection's context for all subsequent requests.

**1. Client-Side Authentication**

```javascript
import { setup, send } from 'webmq-frontend';

setup('ws://localhost:8080');

// After connecting, send the token via an 'auth' message.
// The 'send' function can be used for this.
const token = 'your_jwt_or_api_key';
send('auth', { token });
```

**2. Backend Authentication Hook**

This hook should be a `pre` hook to ensure it runs before any action-specific hooks. It handles the `auth` message and secures all other actions.

```javascript
const authHook = async (context, message, next) => {
  // The 'auth' action is a special case to set up the context.
  if (message.action === 'auth') {
    const user = await myApp.verifyToken(message.payload.token); // Your own token verification logic
    if (!user) throw new Error('Authentication failed');
    
    context.user = user; // Attach user identity to the connection context
    console.log(`Client ${context.id} authenticated as ${user.id}`);
    return; // Stop further processing for this auth message
  }

  // For all other actions, check if a user is present on the context
  if (!context.user) {
    throw new Error('Client is not authenticated');
  }

  // If authenticated, proceed to the next hook or the main logic
  await next();
};

const server = new WebMQServer({
  // ...
  hooks: {
    pre: [authHook],
    onListen: [ /* other validation hooks... */ ]
  }
});
```

---

## React Usage Examples

Here are two examples of how to use `webmq-frontend` in a React application to handle common asynchronous UI patterns.

### Example 1: Asynchronous Task (Stock Order)

This pattern is ideal for tasks that are initiated by the client and then processed asynchronously on the backend. The client submits a task and then subscribes to status updates for that specific task.

```jsx
import React, { useState, useEffect } from 'react';
import { send, listen, unlisten } from 'webmq-frontend';

// Component to display the status of a single order
const OrderStatus = ({ orderId }) => {
  const [status, setStatus] = useState('Submitted');

  useEffect(() => {
    const topic = `order.status.${orderId}`;
    
    const handleUpdate = (update) => setStatus(update.status);

    listen(topic, handleUpdate);
    console.log(`Listening for updates on ${topic}`);

    // Cleanup function to unlisten when the component unmounts
    return () => {
      unlisten(topic, handleUpdate);
      console.log(`Stopped listening on ${topic}`);
    };
  }, [orderId]); // Re-run effect if orderId changes

  return <div>Order ID: {orderId} | Status: <strong>{status}</strong></div>;
};

// Main component that contains the order form and status display
export const OrderPlacer = () => {
  const [orderId, setOrderId] = useState(null);

  const handlePlaceOrder = (event) => {
    event.preventDefault();
    const newId = crypto.randomUUID();
    const orderDetails = { stock: 'GEM', quantity: 100, price: 1000 };

    console.log(`Placing order with ID: ${newId}`);
    send(`order.create`, { ...orderDetails, id: newId });
    
    setOrderId(newId); // Show the status component
  };

  if (orderId) {
    return <OrderStatus orderId={orderId} />;
  }

  return (
    <form onSubmit={handlePlaceOrder}>
      <p>Stock: GEM, Quantity: 100</p>
      <button type="submit">Place Order</button>
    </form>
  );
};
```

### Example 2: Data Fetching (Activity Feed)

This pattern replaces a traditional `GET` request. The client requests a "virtual" resource, and a backend worker gathers the data and publishes it back to a topic unique to that request. This is useful for populating lists, dashboards, or feeds.

**Frontend React Component**

```jsx
import React, { useState, useEffect } from 'react';
import { send, listen, unlisten } from 'webmq-frontend';

export const ActivityFeed = () => {
  const [activities, setActivities] = useState([]);

  useEffect(() => {
    const feedId = crypto.randomUUID();
    const topic = `activity_feed.data.${feedId}`;

    const handleNewActivities = (data) => {
      // Add new activities to the list
      setActivities(current => [...current, ...data.activities]);
    };

    console.log(`Listening for activity feed on ${topic}`);
    listen(topic, handleNewActivities);

    // Request the activity feed by sending an event
    console.log(`Requesting activity feed with ID: ${feedId}`);
    send(`activity_feed.get`, { feedId, count: 20 });

    // Cleanup on unmount
    return () => unlisten(topic, handleNewActivities);
  }, []); // Runs once when the component mounts

  return (
    <ul>
      {activities.map(activity => (
        <li key={activity.id}>{activity.text}</li>
      ))}
    </ul>
  );
};
```

**Backend Worker (Pseudocode)**

A separate backend service (written in any language, e.g., Python, Go, or another Node.js process) would be listening for the `activity_feed.get` event.

```python
# Example Python worker using the 'pika' library

def on_feed_request(channel, method, properties, body):
    message = json.loads(body)
    feed_id = message['feedId']
    
    # 1. Fetch data from a database or other services
    activities = db.get_latest_activities(count=message['count'])
    
    # 2. Publish the data back to the specific topic the client is listening on
    response_topic = f"activity_feed.data.{feed_id}"
    channel.basic_publish(
        exchange='my_app_exchange', 
        routing_key=response_topic, 
        body=json.dumps({ 'activities': activities })
    )

# Listen on a queue bound to the 'activity_feed.get' routing key
channel.basic_consume(queue='feed_requests', on_message_callback=on_feed_request, auto_ack=True)
channel.start_consuming()
```

---

## Potential Future Features

(TODO: update this section if we already implemented something)

This section tracks potential enhancements that could be added to WebMQ in the future.

### Frontend Features

- **Connection Management:**
  - ✅ `disconnect()` method to manually close connection (implemented)
  - ✅ Automatic reconnection with exponential backoff (implemented)
  - ✅ Connection state events (`connect`, `disconnect`, `reconnect`) (implemented)
  - Connection timeout configuration
  - `isConnected()` status method

- **Message Features:**
  - ✅ Message acknowledgments/confirmations from server (implemented)
  - ✅ Message queuing when disconnected (with configurable limits) (implemented)
  - Request-response pattern (`request(topic, data)` returns Promise)
  - Message filtering/transformation functions
  - Message batching to reduce WebSocket overhead
  - Hooks for Frontend

- **Developer Experience:**
  - Debug mode with verbose logging
  - TypeScript interfaces for message payloads
  - Connection health monitoring

- **Authentication:**
  - Auth token support in `setup()` options
  - Token refresh handling

### Backend Features

- **Production Readiness:**
  - Authentication middleware (JWT validation, user context)
  - Rate limiting per connection/user
  - Graceful shutdown handling
  - Health checks endpoint for monitoring

- **Message Processing:**
  - Message persistence (store-and-forward for offline clients)
  - Message transformation hooks (validation, sanitization)
  - Dead letter queues for failed messages
  - Multiple exchange support (not just topic)

### Coordinated Frontend + Backend Features

- **Enhanced Communication:**
  - Request-response pattern (requires coordination between frontend and backend)
  - Message acknowledgments (server confirms delivery)
  - Presence system (who's online/offline)
  - Room/namespace support (isolated message spaces)
  - Look into (de)serialization options for speed and memory (msgpack perhaps?)

### Priority Recommendations

The highest impact additions would be:

1. **Backend auth middleware** (production necessity)
2. **Frontend auto-reconnection** (reliability)
3. **Request-response pattern** (developer experience)
