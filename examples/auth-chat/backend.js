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
  exchangeName: 'auth_chat_app',
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
