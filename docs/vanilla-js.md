# Vanilla JavaScript

WebMQ works with plain JavaScript — no framework required. The `WebMQClient` class connects to your backend, publishes events, and listens for messages.

## Basic setup

```html
<script type="module">
  import WebMQClient from 'webmq-frontend';

  const client = new WebMQClient({
    url: 'ws://localhost:8080',
    sessionId: crypto.randomUUID()
  });
  client.connect();
</script>
```

## Publish and listen

```html
<script type="module">
  import WebMQClient from 'webmq-frontend';

  const client = new WebMQClient({
    url: 'ws://localhost:8080',
    sessionId: crypto.randomUUID()
  });
  client.connect();

  // Subscribe to events
  client.listen('notifications', (notification) => {
    showToast(notification.title, notification.body);
  });

  // Publish events
  document.getElementById('btn').onclick = () => {
    client.publish('notifications', {
      title: 'Button clicked',
      body: 'Someone clicked the button'
    });
  };
</script>
```

## Connection status

`WebMQClient` extends `EventTarget`, so you can listen for connection state changes:

```javascript
client.addEventListener('connected', () => {
  document.getElementById('status').textContent = '🟢 Connected';
});

client.addEventListener('disconnected', () => {
  document.getElementById('status').textContent = '🔴 Disconnected';
});

client.addEventListener('reconnecting', (event) => {
  document.getElementById('status').textContent =
    `🟡 Reconnecting... attempt ${event.detail.attempt}`;
});
```

## Full example: real-time search

This example sends a search request and listens for results from multiple workers:

```html
<!DOCTYPE html>
<html>
<body>
  <input id="query" placeholder="Search..." />
  <button id="search">Search</button>
  <div id="results"></div>

  <script type="module">
    import WebMQClient from 'webmq-frontend';

    const client = new WebMQClient({
      url: 'ws://localhost:8080',
      sessionId: crypto.randomUUID()
    });
    client.connect();

    document.getElementById('search').onclick = () => {
      const query = document.getElementById('query').value;
      const searchId = crypto.randomUUID();

      // Listen for results specific to this search
      client.listen(`search.results.${searchId}`, (result) => {
        const div = document.getElementById('results');
        div.innerHTML += `<div><b>${result.source}:</b> ${JSON.stringify(result.data)}</div>`;
      });

      // Publish the search request
      client.publish('search.request', { searchId, query });
    };
  </script>
</body>
</html>
```

## Using multiple clients

Connect to different WebMQ backends simultaneously:

```javascript
const chatClient = new WebMQClient({
  url: 'ws://chat.example.com',
  sessionId: 'user-session'
});

const analyticsClient = new WebMQClient({
  url: 'ws://analytics.example.com',
  sessionId: 'user-session'
});

chatClient.connect();
analyticsClient.connect();
```

## Lifecycle

| Method | Description |
|---|---|
| `connect()` | Open WebSocket connection, start reconnection logic |
| `disconnect()` | Close connection gracefully, stop reconnection |
| `forceReconnect()` | Force immediate reconnection attempt |
| `publish(key, payload)` | Publish event, returns Promise<void> (resolves on server ACK) |
| `listen(key, callback)` | Subscribe to events, returns Promise<void> |
| `unlisten(key, callback)` | Unsubscribe, returns Promise<void> |
