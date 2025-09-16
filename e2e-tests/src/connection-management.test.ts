import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { GlobalTestSetup, getTestExchangeName } from './test-setup-global';

describe('WebMQ Connection Management', () => {
  let rabbitmqUrl: string;
  let backend: any;
  let backendPort: number;
  let exchangeName: string;

  beforeAll(async () => {
    // Use shared RabbitMQ container
    const globalSetup = GlobalTestSetup.getInstance();
    rabbitmqUrl = await globalSetup.getRabbitMQUrl();
    console.log('🚀 Using in-memory AMQP mock for connection management test');

    // Generate unique exchange name for test isolation
    exchangeName = getTestExchangeName('connection_management');
    backendPort = await getAvailablePort();

    // Create backend
    // TODO: Can't we simply import this at the top?
    const WebMQBackend = (await import('webmq-backend')).WebMQBackend;
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName
    });

    await backend.start(backendPort);
  });

  afterAll(async () => {
    try {
      if (backend) {
        await backend.stop();
        // Wait for backend cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.warn('Error stopping backend:', error);
    }

    // Force garbage collection if available (no need to stop shared container)
    if (global.gc) {
      global.gc();
    }
  });

  test('should handle multiple simultaneous client connections', async () => {
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    const clientCount = 3;
    const clients: any[] = [];

    // Create multiple clients
    for (let i = 0; i < clientCount; i++) {
      const client = new WebMQClient();
      client.setup(`ws://localhost:${backendPort}`);
      clients.push(client);

      await waitForConnection(client);
    }

    // All clients should be connected
    expect(clients).toHaveLength(clientCount);

    // Send message from each client
    for (let i = 0; i < clientCount; i++) {
      await clients[i].send(`test.client.${i}`, {
        clientId: i,
        message: `Message from client ${i}`
      });
    }

    await sleep(500);

    // Cleanup
    for (const client of clients) {
      client.clearQueue();
      client.disconnect({ onActiveListeners: 'clear' });
    }

    // Wait for all clients to disconnect
    await new Promise(resolve => setTimeout(resolve, 100));

    // Test passed if no errors thrown
    expect(true).toBe(true);
  });

  test('should handle client reconnection', async () => {
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    const client = new WebMQClient();

    client.setup(`ws://localhost:${backendPort}`);
    await waitForConnection(client);

    // Send initial message
    await client.send('reconnect.test', { phase: 'before_disconnect' });
    await sleep(200);

    // Force disconnect
    client.disconnect({ onActiveListeners: 'ignore' });
    await sleep(500);

    // Reconnect
    await waitForConnection(client);
    await sleep(200);

    // Send message after reconnection
    await client.send('reconnect.test', { phase: 'after_reconnect' });
    await sleep(500);

    client.disconnect({ onActiveListeners: 'clear' });

    // Test passed if no errors thrown
    expect(true).toBe(true);
  });

  test('should handle connection state events', async () => {
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    const client = new WebMQClient();
    const events: string[] = [];

    // Track connection events
    client.on('connect', () => events.push('connect'));
    client.on('disconnect', () => events.push('disconnect'));
    client.on('error', () => events.push('error'));

    client.setup(`ws://localhost:${backendPort}`);
    await waitForConnection(client);

    expect(events).toContain('connect');

    client.disconnect({ onActiveListeners: 'clear' });
    await sleep(200);

    expect(events).toContain('disconnect');
  });

  test('should handle concurrent send operations', async () => {
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    const client = new WebMQClient();

    client.setup(`ws://localhost:${backendPort}`);
    await waitForConnection(client);

    // Send multiple messages concurrently
    const sendPromises = [];
    for (let i = 0; i < 10; i++) {
      sendPromises.push(
        client.send(`concurrent.${i % 3}`, {
          id: i,
          timestamp: Date.now()
        })
      );
    }

    await Promise.all(sendPromises);
    await sleep(500);

    client.disconnect({ onActiveListeners: 'clear' });

    // Test passed if no errors thrown
    expect(true).toBe(true);
  });

  test('should handle graceful shutdown sequence', async () => {
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    const clients: any[] = [];
    const shutdownEvents: string[] = [];

    // Create multiple clients
    for (let i = 0; i < 3; i++) {
      const client = new WebMQClient();
      client.setup(`ws://localhost:${backendPort}`);
      await waitForConnection(client);

      client.on('disconnect', () => {
        shutdownEvents.push(`client-${i}-disconnected`);
      });

      clients.push(client);
    }

    // Gracefully disconnect all clients
    for (let i = 0; i < clients.length; i++) {
      clients[i].disconnect({ onActiveListeners: 'clear' });
    }

    await sleep(1000);

    // All clients should have disconnected
    expect(shutdownEvents).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(shutdownEvents).toContain(`client-${i}-disconnected`);
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
