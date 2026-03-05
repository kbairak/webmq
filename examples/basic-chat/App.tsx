import WebMQClient from '@webmq-frontend';
import { useRef, useState, useCallback, useEffect } from 'react';

// TODOs:
//   - Lingering ws connection on react strict mode

type UUID = ReturnType<typeof crypto.randomUUID>;
interface Message { id: UUID; text: string; user: string; };

const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Joe'];
const randomName = () => names[Math.floor(Math.random() * names.length)];

export default function Chat() {
  const username = useRef(randomName());
  const webMQClient = useRef(new WebMQClient({
    url: 'ws://localhost:8080', sessionId: crypto.randomUUID()
  }));
  const [messages, setMessages] = useState<{ [id: UUID]: Message }>({});

  const onMessageAdded = useCallback((msg: Message) => {
    setMessages((prev) => ({ ...prev, [msg.id]: msg }));
  }, []);

  const c = webMQClient.current;
  useEffect(() => {
    c.logLevel = 'DEBUG';
    const _log = (event: CustomEvent) => console.log(event.detail)
    c.addEventListener('log', _log);
    const connectPromise = c.connect()
      .then(() => { c.listen('chat.messages', onMessageAdded); })
    return () => {
      c.removeEventListener('log', _log);
      connectPromise
        .then(() => c.unlisten('chat.messages', onMessageAdded))
        .then(() => c.disconnect());
    };
  }, []);

  const handleSubmit = (formData: FormData) => {
    const message = formData.get('message') as string;
    if (!message.trim()) { return; }
    const id = crypto.randomUUID();
    // Let's render this optimistically
    setMessages((prev) => ({
      ...prev, [id]: { id, text: message, user: username.current }
    }));
    c.publish('chat.messages', { id: id, text: message, user: username.current });
    formData.delete('message');
  };

  return (
    <div>
      <h2>My name is {username.current}</h2>
      {Object.values(messages).map((msg) => (
        <p key={msg.id}><b>{msg.user}</b>: {msg.text}</p>
      ))}
      <form action={handleSubmit}><input name="message" /><button>Send</button></form>
    </div>
  );
}
