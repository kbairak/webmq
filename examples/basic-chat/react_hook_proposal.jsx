import { useRef, useState, useCallback, useEffect } from 'react';

const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Joe'];
const randomName = () => names[Math.floor(Math.random() * names.length)];

export default function Chat() {
  const username = useRef(randomName());
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);

  // sessionID by default is random UUID get-or-created on sessionStorage
  const webMQClient = useWebMQ({ url: 'ws://localhost:8080' });

  const onMessageAdded = useCallback((msg) => { setMessages((prev) => [...prev, msg]); }, []);

  useEffect(() => {
    const p = webMQClient.listen('chat.messages', onMessageAdded);
    return () => { p.then(() => webMQClientunlisten('chat.messages', onMessageAdded)); };
  }, [webMQClient, onMessageAdded]);

  const handleSendMessage = (e) => {
    e.preventDefault();
    webMQClient.current.publish('chat.messages', {
      id: crypto.randomUUID(), text: input, user: username.current
    });
    setInput('');
  };

  return (
    <div>
      <h2>My name is {username.current}</h2>
      {messages.map((msg) => (
        <p key={msg.id}>
          <b>{msg.user}</b>: {msg.text}
        </p>
      ))}
      <form onSubmit={handleSendMessage}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button>Send</button>
      </form>
    </div>
  );
}
