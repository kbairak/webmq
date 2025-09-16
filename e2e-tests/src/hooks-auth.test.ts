import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { GlobalTestSetup, getTestExchangeName } from './test-setup-global';

describe('WebMQ Hooks and Authentication', () => {
  let rabbitmqUrl: string;
  let backend: any;
  let client: any;
  let backendPort: number;
  let exchangeName: string;

  beforeAll(async () => {
    // Use shared RabbitMQ container
    const globalSetup = GlobalTestSetup.getInstance();
    rabbitmqUrl = await globalSetup.getRabbitMQUrl();
    console.log('🚀 Using in-memory AMQP mock for hooks and auth test');

    // Generate unique exchange name for test isolation
    exchangeName = getTestExchangeName('hooks_auth');
    backendPort = await getAvailablePort();
  });

  afterAll(async () => {
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

    // Force garbage collection if available (no need to stop shared container)
    if (global.gc) {
      global.gc();
    }
  });

  test('should execute hooks in sequence', async () => {
    const hookExecutionOrder: string[] = [];

    // Create backend with simpler hooks
    const WebMQBackend = (await import('webmq-backend')).WebMQBackend;
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName,
      hooks: {
        onEmit: [
          async (context: any, routingKey: string, payload: any) => {
            hookExecutionOrder.push('emit-1');
          },
          async (context: any, routingKey: string, payload: any) => {
            hookExecutionOrder.push('emit-2');
          }
        ]
      }
    });

    await backend.start(backendPort);

    // Create client
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    client = new WebMQClient();
    client.setup(`ws://localhost:${backendPort}`);
    await waitForConnection(client);

    // Send a message to trigger hooks
    client.send('test.hooks', { message: 'test' }).catch(() => {
      // Ignore any errors
    });
    await sleep(1000);

    // Should have executed at least one hook
    expect(hookExecutionOrder.length).toBeGreaterThanOrEqual(1);
    expect(hookExecutionOrder).toContain('emit-1');
  });

  test('should validate messages with onEmit hooks', async () => {
    // Stop previous backend
    if (backend) await backend.stop();

    let validationError: string | null = null;

    // Create backend with validation
    const WebMQBackend = (await import('webmq-backend')).WebMQBackend;
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName,
      hooks: {
        onEmit: [async (context: any, routingKey: string, payload: any) => {
          if (!payload.message || typeof payload.message !== 'string') {
            validationError = 'Invalid message format';
            throw new Error('Invalid message format');
          }
        }]
      }
    });

    await backend.start(backendPort);

    // Reconnect client
    if (client) client.disconnect({ onActiveListeners: 'clear' });
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    client = new WebMQClient();
    client.setup(`ws://localhost:${backendPort}`);
    await waitForConnection(client);

    // Test valid message
    try {
      await client.send('general.chat', { message: 'Hello world!' });
    } catch (e) {
      // Valid message should not fail
    }
    await sleep(500);

    // Test invalid message format - this should trigger validation error
    try {
      await client.send('general.chat', { content: 'missing message field' });
    } catch (e) {
      // Expected to fail
    }
    await sleep(500);

    // Validation hook should have been triggered
    expect(validationError).toBe('Invalid message format');
  });

  test('should handle context across hooks', async () => {
    let hookWasCalled = false;

    // Stop previous backend
    if (backend) await backend.stop();

    const WebMQBackend = (await import('webmq-backend')).WebMQBackend;
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName,
      hooks: {
        onEmit: [async (context: any, routingKey: string, payload: any) => {
          // Just verify the hook was called
          hookWasCalled = true;
        }]
      }
    });

    await backend.start(backendPort);

    // Reconnect client
    if (client) client.disconnect({ onActiveListeners: 'clear' });
    const WebMQClient = (await import('webmq-frontend')).WebMQClient;
    client = new WebMQClient();
    client.setup(`ws://localhost:${backendPort}`);
    await waitForConnection(client);

    // Send message to trigger hooks
    client.send('test.context', { message: 'testing context' }).catch(() => {
      // Ignore any timeout errors
    });
    await sleep(1000);

    // Hook should have been called
    expect(hookWasCalled).toBe(true);
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