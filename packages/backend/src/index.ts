import WebSocket from 'ws';
import amqplib, { Connection, Channel, ChannelModel } from 'amqplib';

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

    const wss = new WebSocket.Server({ port });
    wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    console.log(`WebMQ Backend started on ws://localhost:${port}`);
  }

  private async handleConnection(ws: WebSocket) {
    if (!this.channelModel) {
      throw new Error('RabbitMQ connection not established.');
    }

    const context: ConnectionContext = { ws, id: crypto.randomUUID() };
    const channel = await this.channelModel.createChannel();
    const clientSubscriptions: Map<string, { queue: string; consumerTag: string }> = new Map();

    console.log(`Client ${context.id} connected.`);

    ws.on('message', async (data: WebSocket.RawData) => {
      try {
        const message: ClientMessage = JSON.parse(data.toString());

        const actionHooks = this.getHooksForAction(message.action);
        const allHooks = [...this.hooks.pre, ...actionHooks];

        const run = async (index: number): Promise<void> => {
          if (index >= allHooks.length) {
            return this.processMessage(channel, context, message, clientSubscriptions);
          }
          await allHooks[index](context, message, () => run(index + 1));
        };

        await run(0);

      } catch (error: any) {
        console.error(`[${context.id}] Error processing message:`, error.message);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });

    ws.on('close', async () => {
      console.log(`Client ${context.id} disconnected. Cleaning up resources.`);
      for (const [bindingKey, sub] of clientSubscriptions.entries()) {
        try {
          await channel.cancel(sub.consumerTag);
          await channel.unbindQueue(sub.queue, this.exchangeName, bindingKey);
          await channel.deleteQueue(sub.queue);
        } catch (err) {
          console.error(`Error cleaning up for bindingKey ${bindingKey}:`, err)
        }
      }
      await channel.close();
    });
  }

  private getHooksForAction(action: ClientMessage['action']): Hook[] {
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

  private async processMessage(
    channel: Channel,
    context: ConnectionContext,
    message: ClientMessage,
    clientSubscriptions: Map<string, { queue: string; consumerTag: string }>
  ) {
    switch (message.action) {
      case 'emit':
        if (!message.routingKey || !message.payload) throw new Error('emit requires routingKey and payload');
        channel.publish(this.exchangeName, message.routingKey, Buffer.from(JSON.stringify(message.payload)));
        break;

      case 'listen':
        if (!message.bindingKey) throw new Error('listen requires a bindingKey');
        if (clientSubscriptions.has(message.bindingKey)) return; // Already listening

        const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
        await channel.bindQueue(queue, this.exchangeName, message.bindingKey);

        const { consumerTag } = await channel.consume(queue, (msg) => {
          if (msg) {
            context.ws.send(JSON.stringify({
              type: 'message',
              bindingKey: message.bindingKey,
              payload: JSON.parse(msg.content.toString()),
            }));
            channel.ack(msg);
          }
        });

        clientSubscriptions.set(message.bindingKey, { queue, consumerTag });
        break;

      case 'unlisten':
        if (!message.bindingKey) throw new Error('unlisten requires a bindingKey');
        const sub = clientSubscriptions.get(message.bindingKey);
        if (sub) {
          await channel.cancel(sub.consumerTag);
          await channel.unbindQueue(sub.queue, this.exchangeName, message.bindingKey);
          await channel.deleteQueue(sub.queue);
          clientSubscriptions.delete(message.bindingKey);
        }
        break;

      default:
        throw new Error('Unknown action');
    }
  }
}
