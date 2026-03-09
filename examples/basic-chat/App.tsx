import { useState, useCallback, useMemo, useEffect } from 'react';
import WebMQClient from '@webmq-frontend';

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

  const webMQClient = useMemo(() => new WebMQClient({
    url: 'ws://localhost:8080', sessionId: crypto.randomUUID(), logLevel: 'DEBUG'
  }), []);
  useEffect(() => {
    webMQClient.connect();
    webMQClient.listen('chat.messages', appendMessage);
    return () => {
      webMQClient.unlisten('chat.messages', appendMessage);
      webMQClient.disconnect();
    };
  }, [webMQClient, appendMessage]);

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
