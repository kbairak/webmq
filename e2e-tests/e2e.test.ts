import { WebMQServer, SubscriptionManager } from 'webmq-backend';
import { WebMQClient } from 'webmq-frontend';
import { getRabbitMQConnection } from './rabbitmq-utils';
import amqplib from 'amqplib';
import net from 'net';

let rabbitmqCleanup: () => Promise<void>;
let rabbitmqUrl: string;
let webmqServer: WebMQServer;
let webmqClient: WebMQClient;
let serverPort: number;
let workerConnection: amqplib.ChannelModel;
let subscriptionManager: SubscriptionManager;

async function findFreePort(startPort: number = 8080): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      // Port is in use, try next one
      resolve(findFreePort(startPort + 1));
    });
  });
}

beforeAll(async () => {
  serverPort = await findFreePort(8080 + Math.floor(Math.random() * 1000));

  // Get RabbitMQ connection (reuses existing or creates new)
  const rabbitmqConnection = await getRabbitMQConnection();
  rabbitmqUrl = rabbitmqConnection.url;
  rabbitmqCleanup = rabbitmqConnection.cleanup;

  // Set up worker connection and subscription manager
  workerConnection = await amqplib.connect(rabbitmqUrl);
  const channel = await workerConnection.createChannel();
  await channel.assertExchange('e2e_exchange', 'topic', { durable: false });
  subscriptionManager = new SubscriptionManager(channel, 'e2e_exchange');

  webmqServer = new WebMQServer({
    rabbitmqUrl: rabbitmqUrl,
    exchangeName: 'e2e_exchange',
  });
  webmqServer.setLogLevel('silent');
  await webmqServer.start(serverPort);

  webmqClient = new WebMQClient();
  webmqClient.setLogLevel('silent');
  webmqClient.setup(`ws://localhost:${serverPort}`);
  await webmqClient.connect();
}, 30000); // 30 second timeout for container startup

afterAll(async () => {
  // Clean up in reverse order
  webmqClient.disconnect({ onActiveListeners: 'clear' });
  await workerConnection.close();
  await webmqServer.stop();
  await rabbitmqCleanup(); // Only stops if we created the container
}, 30000); // 30 second timeout for cleanup

it('worker receives message', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await subscriptionManager.subscribeJSON('routingKey', (payload) => {
    capturedMessages.push(payload);
  });

  // act
  await webmqClient.publish('routingKey', { hello: 'from frontend' });

  // assert
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ hello: 'from frontend' }]);
});

it('client receives message', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await webmqClient.listen('routingKey', (msg) => { capturedMessages.push(msg); });
  await new Promise(resolve => setTimeout(resolve, 100));

  // act
  await subscriptionManager.publish('routingKey', { hello: 'from backend' });

  // assert
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ hello: 'from backend' }]);
});

it('multiple messages in sequence', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await webmqClient.listen('test.sequence', (msg) => { capturedMessages.push(msg); });
  await new Promise(resolve => setTimeout(resolve, 100));

  // act
  await subscriptionManager.publish('test.sequence', { id: 1 });
  await subscriptionManager.publish('test.sequence', { id: 2 });
  await subscriptionManager.publish('test.sequence', { id: 3 });

  // assert
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
});

it('wildcard routing patterns', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await webmqClient.listen('user.*', (msg) => { capturedMessages.push(msg); });
  await new Promise(resolve => setTimeout(resolve, 100));

  // act
  await subscriptionManager.publish('user.login', { action: 'login' });
  await subscriptionManager.publish('user.logout', { action: 'logout' });

  // assert
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ action: 'login' }, { action: 'logout' }]);
});

it('frontend wildcard receives backend specific routing keys', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await webmqClient.listen('order.*', (msg) => { capturedMessages.push(msg); });
  await new Promise(resolve => setTimeout(resolve, 100));

  // act
  await subscriptionManager.publish('order.created', { id: 123 });
  await subscriptionManager.publish('order.updated', { id: 123, status: 'shipped' });
  await subscriptionManager.publish('payment.completed', { id: 456 }); // Should not match

  // assert
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([
    { id: 123 },
    { id: 123, status: 'shipped' }
  ]);
});

it('backend wildcard receives frontend specific routing keys', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await subscriptionManager.subscribeJSON('notification.*', (payload) => {
    capturedMessages.push(payload);
  });
  await new Promise(resolve => setTimeout(resolve, 100));

  // act
  await webmqClient.publish('notification.email', { type: 'email', subject: 'Hello' });
  await webmqClient.publish('notification.sms', { type: 'sms', text: 'Hi' });
  await webmqClient.publish('analytics.click', { button: 'submit' }); // Should not match

  // assert
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([
    { type: 'email', subject: 'Hello' },
    { type: 'sms', text: 'Hi' }
  ]);
});
