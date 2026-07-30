# React

WebMQ integrates naturally with React. Create a `WebMQClient` instance, connect it, and use React hooks for lifecycle management.

## Basic pattern

```jsx
import { useEffect, useRef, useState, useCallback } from 'react';
import WebMQClient from 'webmq-frontend';

function useWebMQ(url, sessionId) {
  const clientRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const client = new WebMQClient({ url, sessionId });
    clientRef.current = client;

    client.addEventListener('connected', () => setConnected(true));
    client.addEventListener('disconnected', () => setConnected(false));

    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [url, sessionId]);

  return { client: clientRef.current, connected };
}
```

## Chat app

```jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import WebMQClient from 'webmq-frontend';

const client = new WebMQClient({
  url: 'ws://localhost:8080',
  sessionId: crypto.randomUUID()
});
client.connect();

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  const onMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    client.listen('chat.messages', onMessage);
    return () => client.unlisten('chat.messages', onMessage);
  }, [onMessage]);

  const send = (e) => {
    e.preventDefault();
    client.publish('chat.messages', {
      id: crypto.randomUUID(),
      text: input,
      user: 'user-' + Math.floor(Math.random() * 1000)
    });
    setInput('');
  };

  return (
    <div>
      {messages.map((msg) => (
        <p key={msg.id}><b>{msg.user}:</b> {msg.text}</p>
      ))}
      <form onSubmit={send}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button>Send</button>
      </form>
    </div>
  );
}
```

## Connection-aware UI

Use the `EventTarget` interface to show connection status:

```jsx
function ConnectionStatus({ client }) {
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    if (!client) return;

    const onConnected = () => setStatus('connected');
    const onDisconnected = () => setStatus('disconnected');
    const onReconnecting = () => setStatus('reconnecting');

    client.addEventListener('connected', onConnected);
    client.addEventListener('disconnected', onDisconnected);
    client.addEventListener('reconnecting', onReconnecting);

    return () => {
      client.removeEventListener('connected', onConnected);
      client.removeEventListener('disconnected', onDisconnected);
      client.removeEventListener('reconnecting', onReconnecting);
    };
  }, [client]);

  const colors = { connected: 'green', disconnected: 'red', reconnecting: 'orange' };

  return <span style={{ color: colors[status] }}>● {status}</span>;
}
```

## Dynamic listen/unlisten

When a search UI needs temporary listeners scoped to a single component:

```jsx
function Search() {
  const [results, setResults] = useState([]);

  const doSearch = (query) => {
    const searchId = crypto.randomUUID();
    const callback = (result) => {
      setResults((prev) => [...prev, result]);
      // Optionally unlisten after receiving all expected results
    };

    client.listen(`search.results.${searchId}`, callback);
    client.publish('search.request', { searchId, query });

    // Cleanup if component unmounts while search is in flight
    return () => client.unlisten(`search.results.${searchId}`, callback);
  };

  // ...
}
```

## Tips

- Create the `WebMQClient` once (module-level or context), not inside render
- Call `connect()` once — it's idempotent on first call
- Pair every `listen()` with an `unlisten()` in `useEffect` cleanup
- Use `useCallback` for listener functions to avoid unnecessary re-subscribes
- The `publish()` function does **not** need to be wrapped — it's stable
