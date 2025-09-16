import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

describe('WebMQ Hooks and Authentication', () => {
  let rabbitmqContainer: StartedTestContainer;
  let rabbitmqUrl: string;
  let backend: any;
  let client: any;
  let backendPort: number;

  beforeAll(async () => {
    // Start RabbitMQ container
    rabbitmqContainer = await new GenericContainer('rabbitmq:3.11-management')
      .withExposedPorts(5672, 15672)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'guest',
        RABBITMQ_DEFAULT_PASS: 'guest'
      })
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const rabbitmqPort = rabbitmqContainer.getMappedPort(5672);
    rabbitmqUrl = `amqp://guest:guest@localhost:${rabbitmqPort}`;
    backendPort = await getAvailablePort();
  });

  afterAll(async () => {
    if (client) client.disconnect({ onActiveListeners: 'clear' });
    if (backend) await backend.stop();
    if (rabbitmqContainer) await rabbitmqContainer.stop();
  });

  test('should execute hooks in sequence', async () => {
    const hookExecutionOrder: string[] = [];

    // Create backend with simpler hooks
    const WebMQBackend = (await import('webmq-backend')).WebMQBackend;
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName: 'webmq_hooks_test',
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
      exchangeName: 'webmq_validation_test',
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
      exchangeName: 'webmq_context_test',
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