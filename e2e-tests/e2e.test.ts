import { WebMQServer } from 'webmq-backend';
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

class RabbitMQManager {
  constructor(private channel: amqplib.Channel, private exchangeName: string) { }

  async subscribeJSON(bindingKey: string, messageHandler: (payload: any) => void) {
    const { queue } = await this.channel.assertQueue('', {
      exclusive: true,
      autoDelete: true,
    });

    await this.channel.bindQueue(queue, this.exchangeName, bindingKey);

    const { consumerTag } = await this.channel.consume(queue, (msg) => {
      if (msg) {
        const payload = JSON.parse(msg.content.toString());
        messageHandler(payload);
        this.channel.ack(msg);
      }
    });

    return { queue, consumerTag };
  }

  async publish(routingKey: string, payload: any): Promise<void> {
    this.channel.publish(
      this.exchangeName,
      routingKey,
      Buffer.from(JSON.stringify(payload))
    );
  }
}

let rabbitMQHelper: RabbitMQManager;

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
  await channel.assertExchange('e2e_exchange_durable', 'topic', {
    durable: true,
  });
  rabbitMQHelper = new RabbitMQManager(channel, 'e2e_exchange_durable');

  webmqServer = new WebMQServer({
    rabbitmqUrl,
    exchangeName: 'e2e_exchange_durable',
    port: serverPort
  });
  webmqServer.logLevel = 'silent'; // Keep tests quiet
  await webmqServer.start();

  webmqClient = new WebMQClient({ url: `ws://localhost:${serverPort}` });
  webmqClient.logLevel = 'silent'; // Keep tests quiet
}, 30000); // 30 second timeout for container startup

afterAll(async () => {
  // Clean up in reverse order
  await workerConnection.close();
  await webmqServer.stop();
  await rabbitmqCleanup(); // Only stops if we created the container
}, 30000); // 30 second timeout for cleanup

it('worker receives message', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await rabbitMQHelper.subscribeJSON('routingKey', (payload) => {
    capturedMessages.push(payload);
  });

  // act
  await webmqClient.publish('routingKey', { hello: 'from frontend' });

  // assert
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ hello: 'from frontend' }]);
});

it('client receives message', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await webmqClient.listen('routingKey', (msg) => {
    capturedMessages.push(msg);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // act
  await rabbitMQHelper.publish('routingKey', { hello: 'from backend' });

  // assert
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ hello: 'from backend' }]);
});

it('multiple messages in sequence', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await webmqClient.listen('test.sequence', (msg) => {
    capturedMessages.push(msg);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // act
  await rabbitMQHelper.publish('test.sequence', { id: 1 });
  await rabbitMQHelper.publish('test.sequence', { id: 2 });
  await rabbitMQHelper.publish('test.sequence', { id: 3 });

  // assert
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
});

it('wildcard routing patterns', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await webmqClient.listen('user.*', (msg) => {
    capturedMessages.push(msg);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // act
  await rabbitMQHelper.publish('user.login', { action: 'login' });
  await rabbitMQHelper.publish('user.logout', { action: 'logout' });

  // assert
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ action: 'login' }, { action: 'logout' }]);
});

it('frontend wildcard receives backend specific routing keys', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await webmqClient.listen('order.*', (msg) => {
    capturedMessages.push(msg);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // act
  await rabbitMQHelper.publish('order.created', { id: 123 });
  await rabbitMQHelper.publish('order.updated', {
    id: 123,
    status: 'shipped',
  });
  await rabbitMQHelper.publish('payment.completed', { id: 456 }); // Should not match

  // assert
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([
    { id: 123 },
    { id: 123, status: 'shipped' },
  ]);
});

it('backend wildcard receives frontend specific routing keys', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await rabbitMQHelper.subscribeJSON('notification.*', (payload) => {
    capturedMessages.push(payload);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // act
  await webmqClient.publish('notification.email', {
    type: 'email',
    subject: 'Hello',
  });
  await webmqClient.publish('notification.sms', { type: 'sms', text: 'Hi' });
  await webmqClient.publish('analytics.click', { button: 'submit' }); // Should not match

  // assert
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([
    { type: 'email', subject: 'Hello' },
    { type: 'sms', text: 'Hi' },
  ]);
});
