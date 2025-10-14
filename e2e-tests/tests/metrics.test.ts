import { WebMQServer } from 'webmq-backend';
import { WebMQClient } from 'webmq-frontend';
import http from 'http';
import { getRabbitMQConnection } from '../rabbitmq-utils';
import net from 'net';

async function findFreePort(startPort: number = 9000): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findFreePort(startPort + 1));
    });
  });
}

describe('Metrics Integration', () => {
  let rabbitmqCleanup: () => Promise<void>;
  let rabbitmqUrl: string;
  let server: WebMQServer;
  let client: WebMQClient;
  let httpServer: http.Server;
  let serverPort: number;

  beforeAll(async () => {
    const rabbitmqConnection = await getRabbitMQConnection();
    rabbitmqUrl = rabbitmqConnection.url;
    rabbitmqCleanup = rabbitmqConnection.cleanup;
  }, 60000);

  afterAll(async () => {
    await rabbitmqCleanup();
  }, 30000);

  beforeEach(async () => {
    serverPort = await findFreePort(9000 + Math.floor(Math.random() * 1000));
    httpServer = http.createServer((req, res) => {
      // Manually wire up metrics endpoint when using external HTTP server
      if (req.url === '/metrics') {
        server.metricsHandler(req, res);
      } else {
        res.writeHead(426);
        res.end('Upgrade Required');
      }
    });

    server = new WebMQServer({
      rabbitmqUrl,
      exchangeName: 'test_metrics',
      server: httpServer,
      metrics: true // Enable metrics
    });
    server.logLevel = 'silent';

    await server.start();
    await new Promise<void>((resolve) => httpServer.listen(serverPort, resolve));

    client = new WebMQClient({ url: `ws://localhost:${serverPort}` });
    client.logLevel = 'silent';
  });

  afterEach(async () => {
    client.close();
    await server.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('should expose metrics endpoint', async () => {
    const response = await fetch(`http://localhost:${serverPort}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const body = await response.text();
    expect(body).toContain('# HELP webmq_');
    expect(body).toContain('# TYPE webmq_');
  });

  it('should track published messages', async () => {
    await client.listen('test.topic', () => {});
    await client.publish('test.topic', { message: 'hello' });

    // Give metrics time to update
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await fetch(`http://localhost:${serverPort}/metrics`);
    const body = await response.text();

    expect(body).toContain('webmq_messages_published_total');
    expect(body).toMatch(/webmq_messages_published_total \d+/);
    expect(body).toContain('webmq_messages_by_routing_key{routing_key="test.topic"}');
  });

  it('should track active connections', async () => {
    // Ensure connection is established by making a call
    await client.listen('connection.test', () => {});
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await fetch(`http://localhost:${serverPort}/metrics`);
    const body = await response.text();

    expect(body).toContain('webmq_connections_active 1');
  });

  it('should track RabbitMQ connection status', async () => {
    const response = await fetch(`http://localhost:${serverPort}/metrics`);
    const body = await response.text();

    expect(body).toContain('webmq_rabbitmq_connected 1');
  });

  it('should track subscriptions', async () => {
    await client.listen('test.*', () => {});
    await client.listen('user.#', () => {});

    // Give metrics time to update
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await fetch(`http://localhost:${serverPort}/metrics`);
    const body = await response.text();

    expect(body).toContain('webmq_subscriptions_active');
    expect(body).toMatch(/webmq_subscriptions_active \d+/);
    expect(body).toContain('webmq_subscriptions_by_binding_key{binding_key="test.*"}');
    expect(body).toContain('webmq_subscriptions_by_binding_key{binding_key="user.#"}');
  });

  it('should track publish latency', async () => {
    await client.listen('latency.test', () => {});
    await client.publish('latency.test', { data: 'test' });

    // Give metrics time to update
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await fetch(`http://localhost:${serverPort}/metrics`);
    const body = await response.text();

    expect(body).toContain('webmq_publish_duration_seconds');
    expect(body).toContain('webmq_publish_duration_seconds_bucket');
    expect(body).toContain('webmq_publish_duration_seconds_count');
    expect(body).toContain('webmq_publish_duration_seconds_sum');
  });

  it('should support custom metrics path', async () => {
    await server.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    const customPort = await findFreePort(9100 + Math.floor(Math.random() * 100));
    httpServer = http.createServer((req, res) => {
      // Manually wire up custom metrics endpoint
      if (req.url === '/prometheus') {
        server.metricsHandler(req, res);
      } else {
        res.writeHead(426);
        res.end('Upgrade Required');
      }
    });

    server = new WebMQServer({
      rabbitmqUrl,
      exchangeName: 'test_custom_path',
      server: httpServer,
      metrics: '/prometheus' // Custom path
    });
    server.logLevel = 'silent';

    await server.start();
    await new Promise<void>((resolve) => httpServer.listen(customPort, resolve));

    const response = await fetch(`http://localhost:${customPort}/prometheus`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('# HELP webmq_');
  });
});
