# Authentication Example

This example shows how to implement JWT-based authentication with WebMQ using identify hooks.

## Backend

```javascript
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { WebMQServer } from 'webmq-backend';

const SECRET = 'your-secret-key';
const app = express();

// Login endpoint
app.post('/login', express.json(), (req, res) => {
  const { username, password } = req.body;
  // Simple validation: password = username repeated twice
  if (password === `${username}${username}`) {
    const token = jwt.sign({ username }, SECRET);
    res.json({ success: true, token });
  } else {
    res.status(403).json({ success: false, error: 'Invalid credentials' });
  }
});

const httpServer = http.createServer(app);

const webMQServer = new WebMQServer({
  rabbitmqUrl: 'amqp://localhost',
  exchangeName: 'chat_app',
  server: httpServer,
  hooks: {
    onIdentify: [async (context, next, message) => {
      // Extract token from identify message payload
      const { token } = message.payload || {};

      if (!token) {
        throw new Error('Authentication required');
      }

      try {
        const { username } = jwt.verify(token, SECRET);
        context.user = { username };
        console.log(`User authenticated: ${username}`);
      } catch (e) {
        throw new Error('Invalid token');
      }

      await next();
    }],
    pre: [async (context, next, message) => {
      // Skip auth check for identify messages (already handled by onIdentify)
      if (message.action === 'identify') {
        await next();
        return;
      }

      // For all other actions, ensure user is authenticated
      if (!context.user) {
        throw new Error('Not authenticated');
      }

      await next();
    }],
    onPublish: [async (context, next, message) => {
      // Auto-add username to all published messages
      message.payload.username = context.user.username;
      message.payload.timestamp = Date.now();
      await next();
    }]
  }
});

await webMQServer.start();
httpServer.listen(8080);
console.log('Server running on http://localhost:8080');
```

## Frontend

```jsx
import { useState, useEffect, useCallback } from 'react';
import { setup, listen, unlisten, publish } from 'webmq-frontend';

export default function App() {
  const [username, setUsername] = useState(null);
  const [token, setToken] = useState(null);

  if (username === null) {
    return <Login onSuccess={({ username, token }) => {
      setUsername(username);
      setToken(token);
    }} />;
  }

  return <Chat username={username} token={token} />;
}

function Login({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    if (!username || !password) {
      setUsername('');
      setPassword('');
      return;
    }

    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (response.ok) {
      const { token } = await response.json();
      onSuccess({ username, token });
    } else {
      alert('Invalid credentials');
      setUsername('');
      setPassword('');
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p>
        Username: <input value={username} onChange={(e) => setUsername(e.target.value)} />
      </p>
      <p>
        Password: <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </p>
      <button>Log in</button>
      <p>Hint: password is username repeated twice (e.g., user 'alice', password 'alicealice')</p>
    </form>
  );
}

function Chat({ username, token }) {
  useEffect(() => {
    setup('ws://localhost:8080', {
      hooks: {
        onIdentify: [async (context, next, message) => {
          // Add token to identify message payload
          message.payload = { token };
          await next();
        }]
      }
    });
  }, [token]);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  const onMessageAdded = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    listen('chat.messages', onMessageAdded);
    return () => unlisten('chat.messages', onMessageAdded);
  }, [onMessageAdded]);

  const sendMessage = (e) => {
    e.preventDefault();
    publish('chat.messages', {
      id: crypto.randomUUID(),
      text: input
      // username is auto-added by backend hook
    });
    setInput('');
  };

  return (
    <div>
      <h2>Chat (logged in as {username})</h2>
      {messages.map(msg => (
        <p key={msg.id}>
          <strong>{msg.username}:</strong> {msg.text}
        </p>
      ))}
      <form onSubmit={sendMessage}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button>Send</button>
      </form>
    </div>
  );
}
```

## Key Points

1. **Token sent once during identify**: The `onIdentify` hook adds the JWT token to the identify message payload
2. **Backend validates on identify**: The backend `onIdentify` hook verifies the token and sets `context.user`
3. **Subsequent requests use context**: The `pre` hook checks `context.user` for all non-identify actions
4. **Auto-enhance messages**: The `onPublish` hook automatically adds username to messages
5. **Clean separation**: Authentication happens during connection, not on every message
