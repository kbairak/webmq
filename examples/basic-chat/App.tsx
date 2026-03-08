import { useState, useCallback, useMemo } from 'react';
import { WebMQClient, useWebMQ, type WebMQClientOptions } from '@webmq-frontend/react';

type UUID = ReturnType<typeof crypto.randomUUID>;
interface Message { id: UUID; text: string; user: string; };

const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Joe'];
const randomName = () => names[Math.floor(Math.random() * names.length)];

export default function Chat() {
  const username = useMemo(randomName, [])
  const [messages, setMessages] = useState<Message[]>([]);

  const appendMessage = useCallback((msg: Message) => setMessages(
    (prev) => ([...prev, msg])
  ), []);

  const options = useMemo<WebMQClientOptions>(() => ({
    url: 'ws://localhost:8080', sessionId: crypto.randomUUID(), logLevel: 'DEBUG'
  }), []);
  const on = useCallback(
    (c: WebMQClient) => c.listen('chat.messages', appendMessage),
    [appendMessage],
  );
  const off = useCallback(
    (c: WebMQClient) => c.unlisten('chat.messages', appendMessage),
    [appendMessage],
  );
  const webMQClient = useWebMQ(options, on, off);

  const handleSubmit = (formData: FormData) => {
    const message = formData.get('message') as string;
    if (!message.trim()) { return; }
    webMQClient.publish('chat.messages', {
      id: crypto.randomUUID(), text: message, user: username
    });
    formData.delete('message');
  };

  return (
    <div>
      <h2>My name is {username}</h2>
      {Object.values(messages).map((msg) => (
        <p key={msg.id}><b>{msg.user}</b>: {msg.text}</p>
      ))}
      <form action={handleSubmit}><input name="message" /><button>Send</button></form>
    </div>
  );
}
