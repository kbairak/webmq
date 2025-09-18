import { setup, listen, publish } from 'webmq-frontend';

const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');

const BINDING_KEY = 'chat.room.1';
const ROUTING_KEY = 'chat.room.1';
const user = 'User-' + Math.random().toString(16).slice(2, 8);

// 1. Setup the connection URL
setup('ws://localhost:8080');

// 2. Listen for messages
listen(BINDING_KEY, (payload) => {
  const item = document.createElement('li');
  item.textContent = `[${new Date().toLocaleTimeString()}] ${payload.user}: ${payload.text}`;
  messages.appendChild(item);
  window.scrollTo(0, document.body.scrollHeight);
});

console.log(`Listening for messages on: ${BINDING_KEY}`);

// 3. Handle form submission to publish messages
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (input.value) {
    const payload = { user, text: input.value };

    console.log(`Emitting message with routing key: ${ROUTING_KEY}`);
    publish(ROUTING_KEY, payload);
    input.value = '';
  }
});