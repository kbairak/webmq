import { setup, listen, unlisten, publish, webMQClient } from 'webmq-frontend';
import { useRef, useState, useCallback, useEffect } from 'react';

setup({ url: 'ws://localhost:8080' });
// webMQClient.logLevel = 'debug';

const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Jack'];
const randomName = () => names[Math.floor(Math.random() * names.length)];

export default function Chat() {
  const username = useRef(randomName());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  const onMessageAdded = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);
  useEffect(() => {
    listen('chat.messages', onMessageAdded);
    return () => unlisten('chat.messages', onMessageAdded);
  }, []);

  const sendMessage = (e) => {
    e.preventDefault();
    publish('chat.messages', {
      id: crypto.randomUUID(), text: input, user: username.current
    });
    setInput('');
  };

  return (
    <div>
      {messages.map(msg => <p key={msg.id}>{msg.user}: {msg.text}</p>)}
      <form onSubmit={sendMessage}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button>Send</button>
      </form>
    </div>
  );
}
