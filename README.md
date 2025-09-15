# WebMQ

WebMQ is a framework designed to bridge web frontends with a RabbitMQ message broker. It uses WebSockets to enable real-time, bidirectional communication, allowing frontend applications to easily publish messages and subscribe to topics.

## Features

- **Real-time Communication:** Built on WebSockets for low-latency message passing.
- **Topic-Based Routing:** Uses a RabbitMQ topic exchange by default for flexible pub/sub patterns.
- **Simple Frontend API:** Provides a clean `emit`, `listen`, and `unlisten` API for frontend applications.
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
import { setup, listen, emit } from 'webmq-frontend';

// 1. Configure the connection
setup('ws://localhost:8080');

const CHAT_TOPIC = 'chat.room.1';

// 2. Listen for messages on a topic
listen(CHAT_TOPIC, (payload) => {
  console.log('Received message:', payload);
});

// 3. Emit a message to a topic
emit(CHAT_TOPIC, { user: 'Alice', text: 'Hello, world!' });
```

### Backend (`webmq-backend`)

The backend is a class that you can integrate into your Node.js application.

```javascript
import { WebMQBackend } from 'webmq-backend';

const backend = new WebMQBackend({
  rabbitmqUrl: 'amqp://guest:guest@localhost:5672',
  exchangeName: 'my_app_exchange',
  // Optional: Add action-specific hooks for auth, validation, etc.
  hooks: {
    onListen: [ myListenHook ],
    onEmit: [ myEmitHook ]
  }
});

backend.start(8080).catch(console.error);
```

### Authentication

Since WebSockets do not use traditional HTTP headers for every request, authentication must be handled using messages. The recommended approach is to have the client send an `auth` message immediately after connecting.

An authentication hook on the backend can then verify the client's token and attach a user identity to the connection's context for all subsequent requests.

**1. Client-Side Authentication**

```javascript
import { setup, emit } from 'webmq-frontend';

setup('ws://localhost:8080');

// After connecting, send the token via an 'auth' message.
// The 'emit' function can be used for this.
const token = 'your_jwt_or_api_key';
emit('auth', { token });
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

const backend = new WebMQBackend({
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
import { emit, listen, unlisten } from 'webmq-frontend';

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
    emit(`order.create`, { ...orderDetails, id: newId });
    
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
import { emit, listen, unlisten } from 'webmq-frontend';

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

    // Request the activity feed by emitting an event
    console.log(`Requesting activity feed with ID: ${feedId}`);
    emit(`activity_feed.get`, { feedId, count: 20 });

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
