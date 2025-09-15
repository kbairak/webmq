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
    console.log(`[${this.id}] Processing message:`, JSON.stringify(message));

    const context: ConnectionContext = { ws: this.ws, id: this.id };
    const hooks = this.backend.getHooksForAction(message.action);

    const run = async (index: number): Promise<void> => {
      if (index >= hooks.length) {
        console.log(`[${this.id}] Executing action: ${message.action}`);
        return this.executeAction(message);
      }
      console.log(`[${this.id}] Running hook ${index}/${hooks.length}`);
      await hooks[index](context, message, () => run(index + 1));
    };

    try {
      await run(0);
      console.log(`[${this.id}] Message processed successfully`);
    } catch (error: any) {
      console.error(`[${this.id}] Error in processMessage:`, error.message);
      console.error(`[${this.id}] Stack trace:`, error.stack);
      throw error;
    }
  }

  private async executeAction(message: ClientMessage): Promise<void> {
    console.log(`[${this.id}] Executing ${message.action} action`);

    try {
      switch (message.action) {
        case 'emit':
          console.log(`[${this.id}] Emit - routingKey: ${message.routingKey}, payload:`, message.payload);
          if (!message.routingKey || !message.payload) {
            throw new Error('emit requires routingKey and payload');
          }
          this.channel.publish(
            this.backend.exchangeName,
            message.routingKey,
            Buffer.from(JSON.stringify(message.payload))
          );
          console.log(`[${this.id}] Message published successfully`);
          break;

        case 'listen':
          console.log(`[${this.id}] Listen - bindingKey: ${message.bindingKey}`);
          if (!message.bindingKey) throw new Error('listen requires a bindingKey');
          if (this.subscriptions.has(message.bindingKey)) {
            console.log(`[${this.id}] Already listening to ${message.bindingKey}`);
            return; // Already listening
          }

          const { queue } = await this.channel.assertQueue('', { exclusive: true, autoDelete: true });
          console.log(`[${this.id}] Queue created: ${queue}`);

          await this.channel.bindQueue(queue, this.backend.exchangeName, message.bindingKey);
          console.log(`[${this.id}] Queue bound to exchange`);

          const { consumerTag } = await this.channel.consume(queue, (msg) => {
            if (msg) {
              console.log(`[${this.id}] Received message from RabbitMQ:`, msg.content.toString());
              this.ws.send(JSON.stringify({
                type: 'message',
                bindingKey: message.bindingKey,
                payload: JSON.parse(msg.content.toString()),
              }));
              this.channel.ack(msg);
            }
          });

          this.subscriptions.set(message.bindingKey, { queue, consumerTag });
          console.log(`[${this.id}] Consumer set up with tag: ${consumerTag}`);
          break;

        case 'unlisten':
          console.log(`[${this.id}] Unlisten - bindingKey: ${message.bindingKey}`);
          if (!message.bindingKey) throw new Error('unlisten requires a bindingKey');
          const sub = this.subscriptions.get(message.bindingKey);
          if (sub) {
            await this.channel.cancel(sub.consumerTag);
            await this.channel.unbindQueue(sub.queue, this.backend.exchangeName, message.bindingKey);
            await this.channel.deleteQueue(sub.queue);
            this.subscriptions.delete(message.bindingKey);
            console.log(`[${this.id}] Unsubscribed from ${message.bindingKey}`);
          } else {
            console.log(`[${this.id}] No subscription found for ${message.bindingKey}`);
          }
          break;

        default:
          throw new Error(`Unknown action: ${message.action}`);
      }
      console.log(`[${this.id}] Action ${message.action} completed successfully`);
    } catch (error: any) {
      console.error(`[${this.id}] Error in executeAction(${message.action}):`, error.message);
      console.error(`[${this.id}] Stack trace:`, error.stack);
      throw error;
    }
  }

  private async cleanup(): Promise<void> {
    console.log(`Client ${this.id} disconnected. Cleaning up resources.`);

    for (const [bindingKey, sub] of this.subscriptions.entries()) {
      try {
        await this.channel.cancel(sub.consumerTag);
        await this.channel.unbindQueue(sub.queue, this.backend.exchangeName, bindingKey);
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
  public readonly exchangeName: string;
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
        return [...this.hooks.pre, ...this.hooks.onListen];
      case 'unlisten':
        return [...this.hooks.pre, ...this.hooks.onUnlisten];
      case 'emit':
        return [...this.hooks.pre, ...this.hooks.onEmit];
      default:
        return this.hooks.pre;
    }
  }
}
