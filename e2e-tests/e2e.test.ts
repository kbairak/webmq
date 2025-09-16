import { RabbitMQContainer, StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { WebMQServer } from 'webmq-backend';
import { WebMQClient } from 'webmq-frontend';
import amqplib from 'amqplib';

let rabbitmq: StartedRabbitMQContainer;
let webmqServer: WebMQServer;
let webmqClient: WebMQClient;
let serverPort: number;

// TODO: This class looks a lot like backend's SubscriptionManager, can we see the similarities, refactor and use SubscriptionManager here?
class Worker {
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private connected: boolean = false;

  private async ensureConnected() {
    if (this.connected) return;
    this.connection = await amqplib.connect(rabbitmq.getAmqpUrl());
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange('e2e_exchange', 'topic', { durable: false });
    this.connected = true;
  }

  public async listen(bindingKey: string, callback: (msg: any) => void) {
    await this.ensureConnected();
    const { queue } = await this.channel!.assertQueue('', { exclusive: true, autoDelete: true });
    await this.channel!.bindQueue(queue, 'e2e_exchange', bindingKey);
    await this.channel!.consume(queue, (msg) => {
      if (msg) {
        callback(JSON.parse(msg.content.toString()));
        this.channel!.ack(msg);
      }
    });
  }

  public async publish(routingKey: string, obj: any) {
    await this.ensureConnected();
    this.channel!.publish(
      'e2e_exchange',
      routingKey,
      Buffer.from(JSON.stringify(obj)),
    );
  }
  public async close() {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.channel = null;
      this.connected = false;
    }
  }
}
const worker = new Worker();

beforeAll(async () => {
  // Use a random port to avoid conflicts
  // TODO: verify if the port is actually free, try a different one if not
  serverPort = 8080 + Math.floor(Math.random() * 1000);

  rabbitmq = await new RabbitMQContainer('rabbitmq:3.11').start();
  webmqServer = new WebMQServer({
    rabbitmqUrl: rabbitmq.getAmqpUrl(),
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
  await worker.close();
  await webmqServer.stop();
  await rabbitmq.stop();
}, 30000); // 30 second timeout for cleanup

it('worker receives message', async () => {
  // arrange
  const capturedMessages: any[] = [];
  await worker.listen('routingKey', (msg) => { capturedMessages.push(msg); });

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
  await worker.publish('routingKey', { hello: 'from backend' });

  // assert
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(capturedMessages).toEqual([{ hello: 'from backend' }]);
});

// TODO: Add more tests, don't test errors, make sure they are no more complex than the existing ones, if something looks complex, don't test it here, we have individual frontend and backend tests anyway
