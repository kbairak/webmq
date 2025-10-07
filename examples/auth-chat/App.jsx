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
    <div className="login-container">
      <h1>WebMQ Auth Chat</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>Username:</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter username"
          />
        </div>
        <div>
          <label>Password:</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
          />
        </div>
        <button type="submit">Log in</button>
        <p className="hint">Hint: password is username repeated twice (e.g., user 'alice', password 'alicealice')</p>
      </form>
    </div>
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
    if (!input.trim()) return;

    publish('chat.messages', {
      id: crypto.randomUUID(),
      text: input
      // username is auto-added by backend hook
    });
    setInput('');
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h2>Auth Chat</h2>
        <span className="username-badge">Logged in as {username}</span>
      </div>
      <div className="messages">
        {messages.map(msg => (
          <div key={msg.id} className="message">
            <strong className="message-username">{msg.username}:</strong>
            <span className="message-text">{msg.text}</span>
          </div>
        ))}
      </div>
      <form onSubmit={sendMessage} className="message-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
