import WebSocket, { WebSocketServer } from 'ws';
import amqplib, { Connection as AMQPConnection, Channel, ChannelModel } from 'amqplib';
import crypto from 'crypto';

// --- Type Definitions ---

/** A WebSocket connection with a unique ID. */
export interface ConnectionContext {
  ws: WebSocket;
  id: string;
  [key: string]: any; // For user data from hooks
}

/** A message received from the client. */
export interface ClientMessage {
  action: 'emit' | 'listen' | 'unlisten';
  routingKey?: string;
  bindingKey?: string;
  payload?: any;
}

/** A hook function to intercept and process messages. */
export type Hook = (
  context: ConnectionContext,
  message: ClientMessage,
  next: () => Promise<void>
) => Promise<void>;

interface WebMQBackendOptions {
  rabbitmqUrl: string;
  exchangeName: string;
  hooks?: {
    pre?: Hook[];
    onListen?: Hook[];
    onEmit?: Hook[];
    onUnlisten?: Hook[];
  };
}

// --- Connection Implementation ---

class Connection {
  private readonly id: string;
  private readonly ws: WebSocket;
  private readonly channel: Channel;
  private readonly backend: WebMQBackend;
  private readonly subscriptions = new Map<string, { queue: string; consumerTag: string }>();

  constructor(ws: WebSocket, channel: Channel, backend: WebMQBackend) {
    this.id = crypto.randomUUID();
    this.ws = ws;
    this.channel = channel;
    this.backend = backend;
  }

  async initialize(): Promise<void> {
    console.log(`Client ${this.id} connected.`);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.ws.on('message', async (data: WebSocket.RawData) => {
      try {
        const message: ClientMessage = JSON.parse(data.toString());
        await this.processMessage(message);
      } catch (error: any) {
        console.error(`[${this.id}] Error processing message:`, error.message);
        this.ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });

    this.ws.on('close', async () => {
      await this.cleanup();
    });
  }

  private async processMessage(message: ClientMessage): Promise<void> {
    const context: ConnectionContext = { ws: this.ws, id: this.id };
    const actionHooks = this.backend.getHooksForAction(message.action);
    const allHooks = [...this.backend.getPreHooks(), ...actionHooks];

    const run = async (index: number): Promise<void> => {
      if (index >= allHooks.length) {
        return this.executeAction(message);
      }
      await allHooks[index](context, message, () => run(index + 1));
    };

    await run(0);
  }

  private async executeAction(message: ClientMessage): Promise<void> {
    switch (message.action) {
      case 'emit':
        if (!message.routingKey || !message.payload) {
          throw new Error('emit requires routingKey and payload');
        }
        await this.channel.publish(
          this.backend.getExchangeName(),
          message.routingKey,
          Buffer.from(JSON.stringify(message.payload))
        );
        break;

      case 'listen':
        if (!message.bindingKey) throw new Error('listen requires a bindingKey');
        if (this.subscriptions.has(message.bindingKey)) return; // Already listening

        const { queue } = await this.channel.assertQueue('', { exclusive: true, autoDelete: true });
        await this.channel.bindQueue(queue, this.backend.getExchangeName(), message.bindingKey);

        const { consumerTag } = await this.channel.consume(queue, (msg) => {
          if (msg) {
            this.ws.send(JSON.stringify({
              type: 'message',
              bindingKey: message.bindingKey,
              payload: JSON.parse(msg.content.toString()),
            }));
            this.channel.ack(msg);
          }
        });

        this.subscriptions.set(message.bindingKey, { queue, consumerTag });
        break;

      case 'unlisten':
        if (!message.bindingKey) throw new Error('unlisten requires a bindingKey');
        const sub = this.subscriptions.get(message.bindingKey);
        if (sub) {
          await this.channel.cancel(sub.consumerTag);
          await this.channel.unbindQueue(sub.queue, this.backend.getExchangeName(), message.bindingKey);
          await this.channel.deleteQueue(sub.queue);
          this.subscriptions.delete(message.bindingKey);
        }
        break;

      default:
        throw new Error('Unknown action');
    }
  }

  private async cleanup(): Promise<void> {
    console.log(`Client ${this.id} disconnected. Cleaning up resources.`);

    for (const [bindingKey, sub] of this.subscriptions.entries()) {
      try {
        await this.channel.cancel(sub.consumerTag);
        await this.channel.unbindQueue(sub.queue, this.backend.getExchangeName(), bindingKey);
        await this.channel.deleteQueue(sub.queue);
      } catch (err) {
        console.error(`Error cleaning up for bindingKey ${bindingKey}:`, err);
      }
    }

    await this.channel.close();
  }
}

// --- Backend Implementation ---

export class WebMQBackend {
  private readonly rabbitmqUrl: string;
  private readonly exchangeName: string;
  private readonly hooks: Required<NonNullable<WebMQBackendOptions['hooks']>>;
  private channelModel: ChannelModel | null = null;

  constructor(options: WebMQBackendOptions) {
    this.rabbitmqUrl = options.rabbitmqUrl;
    this.exchangeName = options.exchangeName;
    this.hooks = {
      pre: options.hooks?.pre || [],
      onListen: options.hooks?.onListen || [],
      onEmit: options.hooks?.onEmit || [],
      onUnlisten: options.hooks?.onUnlisten || [],
    };
  }

  public async start(port: number): Promise<void> {
    console.log('Starting WebMQ Backend...');
    this.channelModel = await amqplib.connect(this.rabbitmqUrl);
    const channel = await this.channelModel.createChannel();
    await channel.assertExchange(this.exchangeName, 'topic', { durable: false });
    await channel.close();

    const wss = new WebSocketServer({ port });
    wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    console.log(`WebMQ Backend started on ws://localhost:${port}`);
  }

  private async handleConnection(ws: WebSocket) {
    if (!this.channelModel) {
      throw new Error('RabbitMQ connection not established.');
    }

    const channel = await this.channelModel.createChannel();
    const connection = new Connection(ws, channel, this);
    await connection.initialize();
  }

  // Public methods for Connection class to access
  public getHooksForAction(action: ClientMessage['action']): Hook[] {
    switch (action) {
      case 'listen':
        return this.hooks.onListen;
      case 'unlisten':
        return this.hooks.onUnlisten;
      case 'emit':
        return this.hooks.onEmit;
      default:
        return [];
    }
  }

  public getPreHooks(): Hook[] {
    return this.hooks.pre;
  }

  public getExchangeName(): string {
    return this.exchangeName;
  }

}
