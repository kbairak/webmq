import WebSocket, { WebSocketServer } from 'ws';
import amqplib, { Channel, ChannelModel } from 'amqplib';
import crypto from 'crypto';
import { EventEmitter } from 'events';

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
  messageId?: string;
}

/** A RabbitMQ subscription with queue and consumer information. */
export interface Subscription {
  queue: string;
  consumerTag: string;
}

/** Connection data stored for each WebSocket client. */
export interface ConnectionData {
  ws: WebSocket;
  subscriptions: Map<string, Subscription>;
  context: ConnectionContext;
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
  exchangeDurable?: boolean; // Default: false for performance in real-time apps
  hooks?: {
    pre?: Hook[];
    onListen?: Hook[];
    onEmit?: Hook[];
    onUnlisten?: Hook[];
  };
}

// --- Connection Management ---

export class ConnectionManager {
  private connections = new Map<string, ConnectionData>();

  createConnection(ws: WebSocket): string {
    const id = crypto.randomUUID();
    const context: ConnectionContext = { ws, id };
    const subscriptions = new Map<string, Subscription>();

    this.connections.set(id, { ws, subscriptions, context });
    return id;
  }

  getConnection(id: string): ConnectionData | undefined {
    return this.connections.get(id);
  }

  removeConnection(id: string): boolean {
    return this.connections.delete(id);
  }

  getAllConnections(): ConnectionData[] {
    return Array.from(this.connections.values());
  }

  getConnectionIds(): string[] {
    return Array.from(this.connections.keys());
  }

  size(): number {
    return this.connections.size;
  }
}

// --- Subscription Management ---

export class SubscriptionManager {
  constructor(
    private channel: Channel,
    private exchangeName: string
  ) { }

  async subscribe(bindingKey: string): Promise<Subscription> {
    const { queue } = await this.channel.assertQueue('', {
      exclusive: true,
      autoDelete: true
    });

    await this.channel.bindQueue(queue, this.exchangeName, bindingKey);

    const { consumerTag } = await this.channel.consume(queue, (msg) => {
      if (msg) {
        // This callback will be overridden by the caller
        this.channel.ack(msg);
      }
    });

    return { queue, consumerTag };
  }

  async unsubscribe(subscription: Subscription, bindingKey: string): Promise<void> {
    await this.channel.cancel(subscription.consumerTag);
    await this.channel.unbindQueue(subscription.queue, this.exchangeName, bindingKey);
    await this.channel.deleteQueue(subscription.queue);
  }

  async publish(routingKey: string, payload: any): Promise<void> {
    this.channel.publish(
      this.exchangeName,
      routingKey,
      Buffer.from(JSON.stringify(payload))
    );
  }

  async cleanupSubscriptions(subscriptions: Map<string, Subscription>): Promise<void> {
    for (const [bindingKey, subscription] of subscriptions.entries()) {
      try {
        await this.unsubscribe(subscription, bindingKey);
      } catch (err) {
        console.error(`Error cleaning up subscription for ${bindingKey}:`, err);
      }
    }
  }

  async createConsumer(
    subscription: Subscription,
    messageHandler: (msg: any) => void
  ): Promise<void> {
    // Cancel existing consumer and create new one with custom handler
    await this.channel.cancel(subscription.consumerTag);

    const { consumerTag } = await this.channel.consume(subscription.queue, (msg) => {
      if (msg) {
        messageHandler(msg);
        this.channel.ack(msg);
      }
    });

    // Update the subscription with new consumer tag
    subscription.consumerTag = consumerTag;
  }
}

// --- Backend Implementation ---

/**
 * WebMQBackend emits the following events:
 *
 * - 'client.connected': { connectionId: string }
 * - 'client.disconnected': { connectionId: string }
 * - 'message.received': { connectionId: string; message: ClientMessage }
 * - 'message.processed': { connectionId: string; message: ClientMessage }
 * - 'subscription.created': { connectionId: string; bindingKey: string; queue: string }
 * - 'subscription.removed': { connectionId: string; bindingKey: string }
 * - 'error': { connectionId?: string; error: Error; context?: string }
 */
export class WebMQBackend extends EventEmitter {
  private readonly rabbitmqUrl: string;
  private readonly exchangeName: string;
  private readonly exchangeDurable: boolean;
  private readonly hooks: Required<NonNullable<WebMQBackendOptions['hooks']>>;
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connectionManager = new ConnectionManager();
  private subscriptionManager: SubscriptionManager | null = null;

  constructor(options: WebMQBackendOptions) {
    super();
    this.rabbitmqUrl = options.rabbitmqUrl;
    this.exchangeName = options.exchangeName;
    this.exchangeDurable = options.exchangeDurable ?? false; // Default to false for performance
    this.hooks = {
      pre: options.hooks?.pre || [],
      onListen: options.hooks?.onListen || [],
      onEmit: options.hooks?.onEmit || [],
      onUnlisten: options.hooks?.onUnlisten || [],
    };
  }

  private wss: WebSocketServer | null = null;

  public async start(port: number): Promise<void> {
    console.log('Starting WebMQ Backend...');

    // Establish RabbitMQ connection and shared channel
    this.connection = await amqplib.connect(this.rabbitmqUrl);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(
      this.exchangeName, 'topic', { durable: this.exchangeDurable }
    );

    // Initialize subscription manager
    this.subscriptionManager = new SubscriptionManager(this.channel, this.exchangeName);

    console.log('RabbitMQ connection and shared channel established');

    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws: WebSocket) => {
      if (!this.channel) {
        throw new Error('Shared channel not established.');
      }

      const id = this.connectionManager.createConnection(ws);

      console.log(`Client ${id} connected.`);
      this.emit('client.connected', { connectionId: id });

      // Set up WebSocket event handlers
      ws.on('message', async (data: WebSocket.RawData) => {
        try {
          const message: ClientMessage = JSON.parse(data.toString());
          this.emit('message.received', { connectionId: id, message });
          await this.processMessage(id, message);
          this.emit('message.processed', { connectionId: id, message });
        } catch (error: any) {
          console.error(`[${id}] Error processing message:`, error.message);
          this.emit('error', { connectionId: id, error, context: 'message processing' });

          // Send nack for failed message
          try {
            const message: ClientMessage = JSON.parse(data.toString());
            if (message.messageId) {
              ws.send(JSON.stringify({
                type: 'nack',
                messageId: message.messageId,
                error: error.message
              }));
              console.log(`[${id}] Sent nack for message ${message.messageId}`);
            } else {
              ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
          } catch (parseError) {
            // If we can't parse the message, send a generic error
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
          }
        }
      });

      ws.on('close', async () => {
        await this.cleanup(id);
      });
    });

    console.log(`WebMQ Backend started on ws://localhost:${port}`);

    // Add error handler to prevent unhandled error crashes
    this.on('error', (errorEvent) => {
      console.error('WebMQ Backend error event:', errorEvent);
      // Don't re-throw, just log it
    });
  }

  public async stop(): Promise<void> {
    console.log('Stopping WebMQ Backend...');

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close RabbitMQ channel and connection
    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }

    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }

    console.log('WebMQ Backend stopped');
  }

  private async processMessage(connectionId: string, message: ClientMessage): Promise<void> {
    const connection = this.connectionManager.getConnection(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    console.log(`[${connectionId}] Processing message:`, JSON.stringify(message));

    const hooks = this.getHooksForAction(message.action);

    const run = async (index: number): Promise<void> => {
      if (index >= hooks.length) {
        console.log(`[${connectionId}] Executing action: ${message.action}`);
        return this.executeAction(connectionId, message);
      }
      console.log(`[${connectionId}] Running hook ${index}/${hooks.length}`);
      await hooks[index](connection.context, message, () => run(index + 1));
    };

    try {
      await run(0);
      console.log(`[${connectionId}] Message processed successfully`);
    } catch (error: any) {
      console.error(`[${connectionId}] Error in processMessage:`, error.message);
      console.error(`[${connectionId}] Stack trace:`, error.stack);
      throw error;
    }
  }

  private async executeAction(connectionId: string, message: ClientMessage): Promise<void> {
    const connection = this.connectionManager.getConnection(connectionId);
    if (!connection || !this.channel || !this.subscriptionManager) {
      throw new Error(`Connection ${connectionId} or shared channel not available`);
    }

    console.log(`[${connectionId}] Executing ${message.action} action`);

    try {
      switch (message.action) {
        case 'emit':
          console.log(`[${connectionId}] Emit - routingKey: ${message.routingKey}, payload:`, message.payload);
          if (!message.routingKey || !message.payload) {
            throw new Error('emit requires routingKey and payload');
          }
          try {
            await this.subscriptionManager.publish(message.routingKey, message.payload);
            console.log(`[${connectionId}] Message published successfully`);

            // Send acknowledgment
            if (message.messageId) {
              connection.ws.send(JSON.stringify({
                type: 'ack',
                messageId: message.messageId,
                status: 'success'
              }));
              console.log(`[${connectionId}] Sent ack for message ${message.messageId}`);
            }
          } catch (error: any) {
            console.error(`[${connectionId}] Error publishing message:`, error.message);

            // Send negative acknowledgment
            if (message.messageId) {
              connection.ws.send(JSON.stringify({
                type: 'nack',
                messageId: message.messageId,
                error: error.message
              }));
              console.log(`[${connectionId}] Sent nack for message ${message.messageId}`);
            }
            throw error; // Re-throw to maintain existing error handling
          }
          break;

        case 'listen':
          console.log(`[${connectionId}] Listen - bindingKey: ${message.bindingKey}`);
          if (!message.bindingKey) throw new Error('listen requires a bindingKey');
          if (connection.subscriptions.has(message.bindingKey)) {
            console.log(`[${connectionId}] Already listening to ${message.bindingKey}`);
            return; // Already listening
          }

          const subscription = await this.subscriptionManager.subscribe(message.bindingKey);
          console.log(`[${connectionId}] Queue created: ${subscription.queue}`);

          // Set up custom message handler
          await this.subscriptionManager.createConsumer(subscription, (msg) => {
            console.log(`[${connectionId}] Received message from RabbitMQ:`, msg.content.toString());
            connection.ws.send(JSON.stringify({
              type: 'message',
              bindingKey: message.bindingKey,
              payload: JSON.parse(msg.content.toString()),
            }));
          });

          connection.subscriptions.set(message.bindingKey, subscription);
          this.emit('subscription.created', {
            connectionId,
            bindingKey: message.bindingKey,
            queue: subscription.queue
          });
          console.log(`[${connectionId}] Consumer set up with tag: ${subscription.consumerTag}`);
          break;

        case 'unlisten':
          console.log(`[${connectionId}] Unlisten - bindingKey: ${message.bindingKey}`);
          if (!message.bindingKey) throw new Error('unlisten requires a bindingKey');
          const sub = connection.subscriptions.get(message.bindingKey);
          if (sub) {
            await this.subscriptionManager.unsubscribe(sub, message.bindingKey);
            connection.subscriptions.delete(message.bindingKey);
            this.emit('subscription.removed', { connectionId, bindingKey: message.bindingKey });
            console.log(`[${connectionId}] Unsubscribed from ${message.bindingKey}`);
          } else {
            console.log(`[${connectionId}] No subscription found for ${message.bindingKey}`);
          }
          break;

        default:
          throw new Error(`Unknown action: ${message.action}`);
      }
      console.log(`[${connectionId}] Action ${message.action} completed successfully`);
    } catch (error: any) {
      console.error(`[${connectionId}] Error in executeAction(${message.action}):`, error.message);
      console.error(`[${connectionId}] Stack trace:`, error.stack);
      throw error;
    }
  }

  private async cleanup(connectionId: string): Promise<void> {
    const connection = this.connectionManager.getConnection(connectionId);
    if (!connection) {
      console.warn(`Connection ${connectionId} not found during cleanup`);
      return;
    }

    console.log(`Client ${connectionId} disconnected. Cleaning up resources.`);

    if (this.subscriptionManager) {
      await this.subscriptionManager.cleanupSubscriptions(connection.subscriptions);
    }

    this.connectionManager.removeConnection(connectionId);
    this.emit('client.disconnected', { connectionId });
  }

  private getHooksForAction(action: ClientMessage['action']): Hook[] {
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
