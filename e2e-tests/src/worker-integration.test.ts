import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import amqplib from 'amqplib';
import { GlobalTestSetup, getTestExchangeName } from './test-setup-global';

describe('WebMQ Worker Integration Test', () => {
  let rabbitmqUrl: string;
  let backend: any;
  let client: any;
  let backendPort: number;
  let workerConnection: any;
  let workerChannel: any;
  let exchangeName: string;

  // Message storage for worker
  const receivedMessages: any[] = [];

  beforeAll(async () => {
    // Use shared RabbitMQ container
    const globalSetup = GlobalTestSetup.getInstance();
    rabbitmqUrl = await globalSetup.getRabbitMQUrl();
    console.log('🚀 Using in-memory AMQP mock for worker integration test');

    // Generate unique exchange name for test isolation
    exchangeName = getTestExchangeName('worker_integration');

    // Set up RabbitMQ worker (direct AMQP consumer)
    console.log('Setting up RabbitMQ worker...');
    workerConnection = await amqplib.connect(rabbitmqUrl);
    workerChannel = await workerConnection.createChannel();

    await workerChannel.assertExchange(exchangeName, 'topic', { durable: false });

    // Create worker queue for specific routing key
    const workerQueue = await workerChannel.assertQueue('worker_queue', {
      exclusive: false,
      autoDelete: true
    });

    // Bind worker queue to routing key pattern
    await workerChannel.bindQueue(workerQueue.queue, exchangeName, 'worker.task.*');

    // Set up worker consumer
    await workerChannel.consume(workerQueue.queue, (msg) => {
      if (msg) {
        const payload = JSON.parse(msg.content.toString());
        console.log('Worker received message:', payload);
        receivedMessages.push({
          routingKey: msg.fields.routingKey,
          payload: payload,
          timestamp: Date.now()
        });
        workerChannel.ack(msg);
      }
    });

    console.log('Worker setup complete, listening for messages...');

    // Start WebMQ Backend
    backendPort = await getAvailablePort();
    const { WebMQBackend } = await import('webmq-backend');
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName: exchangeName
    });

    console.log(`Starting WebMQ backend on port ${backendPort}...`);
    await backend.start(backendPort);

    // Create WebMQ Client
    const { WebMQClient } = await import('webmq-frontend');
    client = new WebMQClient();
    client.setup(`ws://localhost:${backendPort}`);

    // Wait for client connection
    await waitForConnection(client);
    console.log('WebMQ client connected');
  });

  afterAll(async () => {
    // Cleanup with proper error handling (no need to stop shared container)
    try {
      if (client) {
        client.disconnect({ onActiveListeners: 'clear' });
      }
    } catch (error) {
      console.warn('Error disconnecting client:', error);
    }

    try {
      if (backend) {
        await backend.stop();
      }
    } catch (error) {
      console.warn('Error stopping backend:', error);
    }

    try {
      if (workerChannel) {
        await workerChannel.close();
      }
    } catch (error) {
      console.warn('Error closing worker channel:', error);
    }

    try {
      if (workerConnection) {
        await workerConnection.close();
      }
    } catch (error) {
      console.warn('Error closing worker connection:', error);
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
  });

  test('should send message from frontend through backend to RabbitMQ worker', async () => {
    // Clear any previous messages
    receivedMessages.length = 0;

    const testMessage = {
      taskId: 'test-task-123',
      action: 'process_data',
      data: { key: 'value', timestamp: Date.now() },
      priority: 'high'
    };

    console.log('Sending message from frontend...');

    // Send message from frontend client
    await client.send('worker.task.data_processing', testMessage);

    console.log('Message sent, waiting for worker to receive...');

    // Wait for worker to receive message
    await waitForMessages(receivedMessages, 1, 3000);

    // Verify worker received the message
    expect(receivedMessages).toHaveLength(1);

    const receivedMessage = receivedMessages[0];
    expect(receivedMessage.routingKey).toBe('worker.task.data_processing');
    expect(receivedMessage.payload).toEqual(testMessage);

    console.log('✅ Complete message flow verified: Frontend → Backend → RabbitMQ → Worker');
  });

  test('should handle multiple messages with different routing keys', async () => {
    // Clear previous messages
    receivedMessages.length = 0;

    const messages = [
      {
        routingKey: 'worker.task.image_processing',
        payload: { taskId: 'img-001', imageUrl: 'https://example.com/image.jpg' }
      },
      {
        routingKey: 'worker.task.email_sending',
        payload: { taskId: 'email-001', recipient: 'test@example.com', subject: 'Test' }
      },
      {
        routingKey: 'worker.task.data_analysis',
        payload: { taskId: 'data-001', dataset: 'user_behavior', timeframe: '24h' }
      }
    ];

    console.log('Sending multiple messages...');

    // Send all messages
    for (const msg of messages) {
      await client.send(msg.routingKey, msg.payload);
    }

    // Wait for all messages to be received
    await waitForMessages(receivedMessages, 3, 5000);

    // Verify all messages were received
    expect(receivedMessages).toHaveLength(3);

    // Verify each message
    for (let i = 0; i < messages.length; i++) {
      const sent = messages[i];
      const received = receivedMessages.find(msg =>
        msg.routingKey === sent.routingKey &&
        JSON.stringify(msg.payload) === JSON.stringify(sent.payload)
      );

      expect(received).toBeDefined();
      expect(received.payload).toEqual(sent.payload);
    }

    console.log('✅ Multiple message routing verified');
  });

  test('should not receive messages with non-matching routing keys', async () => {
    // Clear previous messages
    receivedMessages.length = 0;

    // Send message that doesn't match worker pattern (worker.task.*)
    await client.send('system.notification.alert', {
      message: 'System alert',
      level: 'warning'
    });

    // Wait a bit to see if any messages arrive
    await sleep(1000);

    // Worker should not have received this message
    expect(receivedMessages).toHaveLength(0);

    console.log('✅ Routing key filtering verified - worker correctly ignored non-matching message');
  });
});

// Helper functions
async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const { createServer } = require('net');
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitForConnection(client: any, timeout: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Connection timeout after ${timeout}ms`));
    }, timeout);

    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });

    client.once('error', (error: any) => {
      clearTimeout(timer);
      reject(error);
    });

    client.connect().catch(reject);
  });
}

async function waitForMessages(messageArray: any[], expectedCount: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkMessages = () => {
      if (messageArray.length >= expectedCount) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout: Expected ${expectedCount} messages, got ${messageArray.length} after ${timeout}ms`));
      } else {
        setTimeout(checkMessages, 50); // Check every 50ms
      }
    };

    checkMessages();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}