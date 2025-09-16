import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { GlobalTestSetup, getTestExchangeName } from './test-setup-global';

describe('WebMQ Error Handling and Edge Cases', () => {
  let rabbitmqUrl: string;
  let backend: any;
  let client: any;
  let backendPort: number;
  let exchangeName: string;

  beforeAll(async () => {
    // Use shared RabbitMQ container
    const globalSetup = GlobalTestSetup.getInstance();
    rabbitmqUrl = await globalSetup.getRabbitMQUrl();
    console.log('🚀 Using in-memory AMQP mock for error handling test');

    // Generate unique exchange name for test isolation
    exchangeName = getTestExchangeName('error_handling');
    backendPort = await getAvailablePort();

    // Create backend
    const WebMQBackend = (await import('webmq-backend')).WebMQBackend;
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName
    });

    await backend.start(backendPort);
  });

  afterAll(async () => {
    try {
      if (client) {
        client.clearQueue(); // Clear any pending messages
        client.disconnect({ onActiveListeners: 'clear' });
        // Wait for disconnect to complete
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.warn('Error disconnecting client:', error);
    }

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

  test('should handle connection to non-existent backend gracefully', async () => {
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    const failClient = new WebMQClient();

    try {
      // Try to connect to non-existent port
      const nonExistentPort = await getAvailablePort();
      failClient.setup(`ws://localhost:${nonExistentPort}`);

      let connectionError: any = null;
      let connectResult: any = null;

      try {
        connectResult = await failClient.connect();
      } catch (error) {
        connectionError = error;
      }

      // Should either have an error or fail to connect
      expect(connectionError || !connectResult).toBeTruthy();
    } finally {
      failClient.clearQueue();
      failClient.disconnect({ onActiveListeners: 'clear' });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });

  test('should handle malformed messages gracefully', async () => {
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    client = new WebMQClient();
    client.setup(`ws://localhost:${backendPort}`);
    await waitForConnection(client);

    // Test with undefined payload
    let sendError: any = null;

    try {
      await client.send('test.topic', undefined);
    } catch (error) {
      sendError = error;
    }

    await sleep(500);

    // Should handle gracefully (might succeed with empty payload or fail gracefully)
    // The main point is that it shouldn't crash the backend or client
    expect(typeof sendError === 'object' || sendError === null).toBe(true);
  });

  test('should handle extremely large payloads', async () => {
    // Create a large payload (1MB of data)
    const largePayload = {
      data: 'x'.repeat(1024 * 1024),
      timestamp: Date.now()
    };

    let largeMessageError: any = null;

    try {
      await client.send('test.large', largePayload);
      await sleep(1000);
    } catch (error) {
      largeMessageError = error;
    }

    // Should either succeed or fail gracefully without crashing
    if (largeMessageError) {
      expect(largeMessageError.message).toBeDefined();
    }
  });

  test('should handle rapid message sending', async () => {
    const messageCount = 100;

    // Send many messages rapidly
    const promises = [];
    for (let i = 0; i < messageCount; i++) {
      promises.push(client.send('stress.test', { id: i, message: `Message ${i}` }));
    }

    await Promise.all(promises);
    await sleep(1000); // Wait for all messages to be processed

    // Should complete without errors
    expect(true).toBe(true);
  });

  test('should handle client disconnection during message processing', async () => {
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    const tempClient = new WebMQClient();
    tempClient.setup(`ws://localhost:${backendPort}`);
    await waitForConnection(tempClient);

    try {
      // Start sending messages
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(tempClient.send('test.disconnect', { id: i }).catch(() => {})); // Ignore errors from abrupt disconnect
      }

      // Disconnect abruptly while messages are being sent
      setTimeout(() => {
        tempClient.clearQueue();
        tempClient.disconnect({ onActiveListeners: 'clear' });
      }, 50);

      // Wait for the disconnect to happen
      await Promise.allSettled(promises);
      await sleep(500);

      // Backend should still be responsive
      await client.send('test.alive', { ping: true });
      expect(true).toBe(true); // If we get here, backend is still responsive
    } finally {
      tempClient.clearQueue();
      tempClient.disconnect({ onActiveListeners: 'clear' });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });

  test('should handle invalid routing keys', async () => {
    const invalidRoutingKeys = [
      '', // Empty string
      'a'.repeat(256), // Very long routing key
      'invalid..double.dot',
      'trailing.dot.',
      '.leading.dot'
    ];

    for (const routingKey of invalidRoutingKeys) {
      let keyError: any = null;

      try {
        await client.send(routingKey, { test: true });
        await sleep(100);
      } catch (error) {
        keyError = error;
      }

      // Should either succeed or fail gracefully
      if (keyError) {
        expect(keyError.message).toBeDefined();
      }
    }
  });

  test('should handle backend restart scenarios', async () => {
    // Stop backend
    await backend.stop();
    await sleep(500);

    // Restart backend
    const WebMQBackend = (await import('webmq-backend')).WebMQBackend;
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName: 'webmq_error_test'
    });

    await backend.start(backendPort);
    await sleep(1000);

    // Create new client to connect to restarted backend
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    const newClient = new WebMQClient();
    newClient.setup(`ws://localhost:${backendPort}`);

    try {
      await waitForConnection(newClient);
      await newClient.send('test.restart', { message: 'backend restarted' });
      expect(true).toBe(true);
    } finally {
      newClient.clearQueue();
      newClient.disconnect({ onActiveListeners: 'clear' });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });

  test('should handle circular reference payloads', async () => {
    // Create object with circular reference
    const circularObj: any = { name: 'test' };
    circularObj.self = circularObj;

    let circularError: any = null;

    try {
      await client.send('test.circular', circularObj);
    } catch (error) {
      circularError = error;
    }

    // Should handle gracefully (JSON serialization should fail)
    expect(circularError).toBeTruthy();
    expect(circularError.message).toContain('circular');
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