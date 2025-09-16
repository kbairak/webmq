import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

// Use dynamic imports for WebMQ packages to avoid ESM issues
async function importWebMQBackend() {
  return (await import('webmq-backend')).WebMQBackend;
}

async function importWebMQClient() {
  return (await import('webmq-frontend')).WebMQClient;
}

export interface TestEnvironment {
  rabbitmqContainer: StartedTestContainer;
  rabbitmqUrl: string;
  backend: any; // WebMQBackend
  client: any; // WebMQClient
  backendPort: number;
}

export class WebMQTestEnvironment {
  private rabbitmqContainer: StartedTestContainer | null = null;
  private backend: any = null; // WebMQBackend
  private client: any = null; // WebMQClient
  private backendPort: number = 0;

  async setup(): Promise<TestEnvironment> {
    // Start RabbitMQ container
    console.log('Starting RabbitMQ container...');
    this.rabbitmqContainer = await new GenericContainer('rabbitmq:3.11-management')
      .withExposedPorts(5672, 15672)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'guest',
        RABBITMQ_DEFAULT_PASS: 'guest'
      })
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const rabbitmqPort = this.rabbitmqContainer.getMappedPort(5672);
    const rabbitmqUrl = `amqp://guest:guest@localhost:${rabbitmqPort}`;
    console.log(`RabbitMQ started on port ${rabbitmqPort}`);

    // Start WebMQ Backend
    this.backendPort = await this.getAvailablePort();
    const WebMQBackend = await importWebMQBackend();
    this.backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName: 'webmq_test_exchange'
    });

    console.log(`Starting WebMQ backend on port ${this.backendPort}...`);
    await this.backend.start(this.backendPort);

    // Create WebMQ Client
    const WebMQClient = await importWebMQClient();
    this.client = new WebMQClient();
    this.client.setup(`ws://localhost:${this.backendPort}`);

    return {
      rabbitmqContainer: this.rabbitmqContainer,
      rabbitmqUrl,
      backend: this.backend,
      client: this.client,
      backendPort: this.backendPort
    };
  }

  async cleanup(): Promise<void> {
    // Disconnect client
    if (this.client) {
      try {
        this.client.disconnect({ onActiveListeners: 'clear' });
      } catch (error) {
        console.warn('Error disconnecting client:', error);
      }
    }

    // Stop backend (WebSocket server)
    if (this.backend) {
      try {
        // Note: WebMQBackend doesn't have a stop method, so we'll just let it clean up naturally
        console.log('Backend cleanup - letting it clean up naturally');
      } catch (error) {
        console.warn('Error stopping backend:', error);
      }
    }

    // Stop RabbitMQ container
    if (this.rabbitmqContainer) {
      try {
        console.log('Stopping RabbitMQ container...');
        await this.rabbitmqContainer.stop();
      } catch (error) {
        console.warn('Error stopping RabbitMQ container:', error);
      }
    }
  }

  async getAvailablePort(): Promise<number> {
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
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForConnection(client: any, timeout: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Connection timeout after ${timeout}ms`));
    }, timeout);

    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });

    client.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    client.connect().catch(reject);
  });
}

export async function getAvailablePort(): Promise<number> {
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