import WebSocket, { WebSocketServer } from 'ws';
import amqplib, { Channel, ChannelModel } from 'amqplib';
import crypto from 'crypto';
import { EventEmitter } from 'events';

// --- Logger Configuration ---

type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

// Global logger for strategy classes and backward compatibility
const logger = {
  error: console.error.bind(console),
  warn: (...args: any[]) => { },    // disabled by default
  info: (...args: any[]) => { },    // disabled by default
  debug: (...args: any[]) => { }    // disabled by default
};

let globalLogLevel: LogLevel = 'error';

function setLogLevel(level: LogLevel) {
  globalLogLevel = level;
  logger.error = level === 'silent' ? (...args: any[]) => { } : console.error.bind(console);
  logger.warn = ['warn', 'info', 'debug'].includes(level) ? console.warn.bind(console) : (...args: any[]) => { };
  logger.info = ['info', 'debug'].includes(level) ? console.log.bind(console) : (...args: any[]) => { };
  logger.debug = level === 'debug' ? console.log.bind(console) : (...args: any[]) => { };
}

// --- Type Definitions ---

/** A WebSocket connection with a unique ID. */
export interface WebSocketConnectionContext {
  ws: WebSocket;
  id: string;
  [key: string]: any; // For user data from hooks
}

/** A message received from the client. */
export interface ClientMessage {
  action: 'publish' | 'listen' | 'unlisten';
  routingKey?: string;
  bindingKey?: string;
  payload?: any;
  messageId?: string;
}

/** A RabbitMQ subscription with queue and consumer information. */
export interface RabbitMQSubscription {
  queue: string;
  consumerTag: string;
}

/** Connection data stored for each WebSocket client. */
export interface WebSocketConnectionData {
  ws: WebSocket;
  subscriptions: Map<string, RabbitMQSubscription>;
  context: WebSocketConnectionContext;
}


/** A hook function to intercept and process messages. */
export type Hook = (
  context: WebSocketConnectionContext,
  message: ClientMessage,
  next: () => Promise<void>
) => Promise<void>;

interface WebMQServerOptions {
  rabbitmqUrl: string;
  exchangeName: string;
  hooks?: {
    pre?: Hook[];
    onListen?: Hook[];
    onPublish?: Hook[];
    onUnlisten?: Hook[];
  };
}

// --- WebSocket Management ---

// TODO: Shouldn't this also do subscribe/unsubscribe/publish etc like RabbitMQManager?
export class WebSocketManager {
  private connections = new Map<string, WebSocketConnectionData>();

  createConnection(ws: WebSocket): string {
    const id = crypto.randomUUID();
    const context: WebSocketConnectionContext = { ws, id };
    const subscriptions = new Map<string, RabbitMQSubscription>();

    this.connections.set(id, { ws, subscriptions, context });
    return id;
  }

  getConnection(id: string): WebSocketConnectionData | undefined {
    return this.connections.get(id);
  }

  removeConnection(id: string): boolean {
    return this.connections.delete(id);
  }

  getAllConnections(): WebSocketConnectionData[] {
    return Array.from(this.connections.values());
  }

  getConnectionIds(): string[] {
    return Array.from(this.connections.keys());
  }

  size(): number {
    return this.connections.size;
  }
}

// --- RabbitMQ Management ---

export class RabbitMQManager {
  constructor(
    private channel: Channel,
    private exchangeName: string
  ) { }

  async subscribe(bindingKey: string, messageHandler: (msg: any) => void): Promise<RabbitMQSubscription> {
    const { queue } = await this.channel.assertQueue('', {
      exclusive: true,
      autoDelete: true
    });

    await this.channel.bindQueue(queue, this.exchangeName, bindingKey);

    const { consumerTag } = await this.channel.consume(queue, (msg) => {
      if (msg) {
        messageHandler(msg)
        this.channel.ack(msg);
      }
    });

    return { queue, consumerTag };
  }

  async subscribeJSON(bindingKey: string, messageHandler: (payload: any) => void): Promise<RabbitMQSubscription> {
    return this.subscribe(bindingKey, (msg) => {
      const payload = JSON.parse(msg.content.toString());
      messageHandler(payload);
    });
  }

  async unsubscribe(subscription: RabbitMQSubscription, bindingKey: string): Promise<void> {
    // Check if channel is still open before attempting cleanup
    if (!this.channel || (this.channel as any).closing || (this.channel as any).closed) {
      return; // Channel is already closed, nothing to clean up
    }

    try {
      // Cancel consumer first - this will trigger autoDelete for the queue
      await this.channel.cancel(subscription.consumerTag);
      // Unbind queue from exchange for clean shutdown
      await this.channel.unbindQueue(subscription.queue, this.exchangeName, bindingKey);
      // Note: Queue deletion is handled automatically by autoDelete when last consumer is removed
    } catch (error: any) {
      // If channel was closed during cleanup, ignore the error
      if (error.message?.includes('Channel closed') ||
        error.message?.includes('Channel closing') ||
        error.message?.includes('IllegalOperationError')) {
        return;
      }
      throw error; // Re-throw other errors
    }
  }

  async publish(routingKey: string, payload: any): Promise<void> {
    this.channel.publish(
      this.exchangeName,
      routingKey,
      Buffer.from(JSON.stringify(payload))
    );
  }

  async cleanupSubscriptions(subscriptions: Map<string, RabbitMQSubscription>): Promise<void> {
    for (const [bindingKey, subscription] of subscriptions.entries()) {
      try {
        await this.unsubscribe(subscription, bindingKey);
      } catch (err) {
        logger.error(`Error cleaning up subscription for ${bindingKey}:`, err);
      }
    }
  }
}

// TODO: I don't like the action strategy pattern, inline these
// --- Action Strategy Pattern ---

interface ActionContext {
  connectionId: string;
  connection: WebSocketConnectionData;
  subscriptionManager: RabbitMQManager;
  serverEmitter: EventEmitter;
}

interface ActionResult {
  success: boolean;
  data?: any;
  error?: string;
}

interface ActionStrategy {
  validate(message: ClientMessage): void;
  execute(context: ActionContext, message: ClientMessage): Promise<ActionResult>;
  respond(context: ActionContext, message: ClientMessage, result: ActionResult): Promise<void>;
}

class PublishStrategy implements ActionStrategy {
  validate(message: ClientMessage): void {
    if (!message.routingKey || !message.payload) {
      throw new Error('publish requires routingKey and payload');
    }
  }

  async execute(context: ActionContext, message: ClientMessage): Promise<ActionResult> {
    try {
      await context.subscriptionManager.publish(message.routingKey!, message.payload);
      logger.debug(`[${context.connectionId}] Message published successfully`);
      return { success: true };
    } catch (error: any) {
      logger.error(`[${context.connectionId}] Error publishing message:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async respond(context: ActionContext, message: ClientMessage, result: ActionResult): Promise<void> {
    if (message.messageId) {
      const response = result.success
        ? { action: 'ack', messageId: message.messageId, status: 'success' }
        : { action: 'nack', messageId: message.messageId, error: result.error };

      context.connection.ws.send(JSON.stringify(response));
      logger.debug(`[${context.connectionId}] Sent ${result.success ? 'ack' : 'nack'} for message ${message.messageId}`);
    }

    if (!result.success) {
      throw new Error(result.error);
    }
  }
}

class ListenStrategy implements ActionStrategy {
  validate(message: ClientMessage): void {
    if (!message.bindingKey) {
      throw new Error('listen requires a bindingKey');
    }
  }

  async execute(context: ActionContext, message: ClientMessage): Promise<ActionResult> {
    if (context.connection.subscriptions.has(message.bindingKey!)) {
      logger.debug(`[${context.connectionId}] Already listening to ${message.bindingKey}`);
      return { success: true, data: 'already_subscribed' };
    }

    const subscription = await context.subscriptionManager.subscribe(message.bindingKey!, (msg) => {
      logger.debug(`[${context.connectionId}] Received message from RabbitMQ:`, msg.content.toString());
      context.connection.ws.send(JSON.stringify({
        action: 'message',
        bindingKey: message.bindingKey,
        payload: JSON.parse(msg.content.toString()),
      }));
    });

    logger.debug(`[${context.connectionId}] Queue created: ${subscription.queue}`);
    context.connection.subscriptions.set(message.bindingKey!, subscription);
    logger.debug(`[${context.connectionId}] Consumer set up with tag: ${subscription.consumerTag}`);

    return { success: true, data: subscription };
  }

  async respond(context: ActionContext, message: ClientMessage, result: ActionResult): Promise<void> {
    if (result.success && result.data !== 'already_subscribed') {
      context.serverEmitter.emit('subscription.created', {
        connectionId: context.connectionId,
        bindingKey: message.bindingKey,
        queue: result.data.queue
      });
    }
  }
}

class UnlistenStrategy implements ActionStrategy {
  validate(message: ClientMessage): void {
    if (!message.bindingKey) {
      throw new Error('unlisten requires a bindingKey');
    }
  }

  async execute(context: ActionContext, message: ClientMessage): Promise<ActionResult> {
    const subscription = context.connection.subscriptions.get(message.bindingKey!);
    if (subscription) {
      await context.subscriptionManager.unsubscribe(subscription, message.bindingKey!);
      context.connection.subscriptions.delete(message.bindingKey!);
      logger.debug(`[${context.connectionId}] Unsubscribed from ${message.bindingKey}`);
      return { success: true, data: subscription };
    } else {
      logger.debug(`[${context.connectionId}] No subscription found for ${message.bindingKey}`);
      return { success: true, data: 'not_found' };
    }
  }

  async respond(context: ActionContext, message: ClientMessage, result: ActionResult): Promise<void> {
    if (result.success && result.data !== 'not_found') {
      context.serverEmitter.emit('subscription.removed', {
        connectionId: context.connectionId,
        bindingKey: message.bindingKey
      });
    }
  }
}

class MessageProcessor {
  private strategies = new Map<string, ActionStrategy>([
    ['publish', new PublishStrategy()],
    ['listen', new ListenStrategy()],
    ['unlisten', new UnlistenStrategy()]
  ]);

  async executeAction(context: ActionContext, message: ClientMessage): Promise<void> {
    const strategy = this.strategies.get(message.action);
    if (!strategy) {
      throw new Error(`Unknown action: ${message.action}`);
    }

    logger.debug(`[${context.connectionId}] Executing ${message.action} action`);

    strategy.validate(message);
    const result = await strategy.execute(context, message);
    await strategy.respond(context, message, result);

    logger.debug(`[${context.connectionId}] Action ${message.action} completed successfully`);
  }
}

// --- Backend Implementation ---

/**
 * WebMQ backend server that bridges WebSocket connections with RabbitMQ message broker.
 *
 * @example
 * ```javascript
 * import { WebMQServer } from 'webmq-backend';
 *
 * const server = new WebMQServer({
 *   rabbitmqUrl: 'amqp://localhost',
 *   exchangeName: 'my_exchange'
 * });
 *
 * await server.start(8080);
 * ```
 *
 * Events emitted by WebMQServer:
 * - 'client.connected': { connectionId: string }
 * - 'client.disconnected': { connectionId: string }
 * - 'message.received': { connectionId: string; message: ClientMessage }
 * - 'message.processed': { connectionId: string; message: ClientMessage }
 * - 'subscription.created': { connectionId: string; bindingKey: string; queue: string }
 * - 'subscription.removed': { connectionId: string; bindingKey: string }
 * - 'error': { connectionId?: string; error: Error; context?: string }
 */
export class WebMQServer extends EventEmitter {
  private readonly rabbitmqUrl: string;
  private readonly exchangeName: string;
  private readonly hooks: Required<NonNullable<WebMQServerOptions['hooks']>>;
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private webSocketManager = new WebSocketManager();
  private rabbitMQManager: RabbitMQManager | null = null;
  private messageProcessor = new MessageProcessor();

  // Instance logger
  private logger = {
    error: console.error.bind(console),
    warn: (...args: any[]) => { },    // disabled by default
    info: (...args: any[]) => { },    // disabled by default
    debug: (...args: any[]) => { }    // disabled by default
  };

  constructor(options: WebMQServerOptions) {
    super();
    this.rabbitmqUrl = options.rabbitmqUrl;
    this.exchangeName = options.exchangeName;
    this.hooks = {
      pre: options.hooks?.pre || [],
      onListen: options.hooks?.onListen || [],
      onPublish: options.hooks?.onPublish || [],
      onUnlisten: options.hooks?.onUnlisten || [],
    };

    // Initialize logger with global log level
    this.setLogLevel(globalLogLevel);
  }

  /**
   * Sets the log level for the WebMQ server instance.
   * @param level The log level to set ('silent', 'error', 'warn', 'info', 'debug')
   */
  public setLogLevel(level: LogLevel): void {
    // Update global logger for strategy classes and backward compatibility
    setLogLevel(level);

    // Update instance logger
    this.logger.error = level === 'silent' ? (...args: any[]) => { } : console.error.bind(console);
    this.logger.warn = ['warn', 'info', 'debug'].includes(level) ? console.warn.bind(console) : (...args: any[]) => { };
    this.logger.info = ['info', 'debug'].includes(level) ? console.log.bind(console) : (...args: any[]) => { };
    this.logger.debug = level === 'debug' ? console.log.bind(console) : (...args: any[]) => { };
  }

  private wss: WebSocketServer | null = null;

  public async start(port: number): Promise<void> {
    this.logger.info('Starting WebMQ Backend...');

    // Establish RabbitMQ connection and shared channel
    this.connection = await amqplib.connect(this.rabbitmqUrl);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(
      this.exchangeName, 'topic', { durable: true }
    );

    // Initialize RabbitMQ manager
    this.rabbitMQManager = new RabbitMQManager(this.channel, this.exchangeName);

    this.logger.info('RabbitMQ connection and shared channel established');

    // TODO:Like we did with RabbitMQManager, lets just initialize WebSocketManager and invoke it instead of interacting with the `wss` and `ws` objects directly
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws: WebSocket) => {
      // TODO: Is this needed yere?
      if (!this.channel) {
        throw new Error('Shared channel not established.');
      }

      const id = this.webSocketManager.createConnection(ws);

      this.logger.info(`Client ${id} connected.`);
      this.emit('client.connected', { connectionId: id });

      // Set up WebSocket event handlers
      ws.on('message', async (data: WebSocket.RawData) => {
        try {
          const message: ClientMessage = JSON.parse(data.toString());
          this.emit('message.received', { connectionId: id, message });
          await this.processMessage(id, message);
          this.emit('message.processed', { connectionId: id, message });
        } catch (error: any) {
          this.logger.error(`[${id}] Error processing message:`, error.message);
          this.emit('error', { connectionId: id, error, context: 'message processing' });

          // Send nack for failed message
          try {
            const message: ClientMessage = JSON.parse(data.toString());
            if (message.messageId) {
              ws.send(JSON.stringify({
                action: 'nack',
                messageId: message.messageId,
                error: error.message
              }));
              this.logger.debug(`[${id}] Sent nack for message ${message.messageId}`);
            } else {
              ws.send(JSON.stringify({ action: 'error', message: error.message }));
            }
          } catch (parseError) {
            // If we can't parse the message, send a generic error
            ws.send(JSON.stringify({ action: 'error', message: error.message }));
          }
        }
      });

      ws.on('close', async () => {
        await this.cleanup(id);
      });
    });

    this.logger.info(`WebMQ Backend started on ws://localhost:${port}`);

    // Add error handler to prevent unhandled error crashes
    this.on('error', (errorEvent) => {
      this.logger.error('WebMQ Backend error event:', errorEvent);
      // Don't re-throw, just log it
    });
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping WebMQ Backend...');

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

    this.logger.info('WebMQ Backend stopped');
  }

  private async processMessage(connectionId: string, message: ClientMessage): Promise<void> {
    const connection = this.webSocketManager.getConnection(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    this.logger.debug(`[${connectionId}] Processing message:`, JSON.stringify(message));

    const hooks = this.getHooksForAction(message.action);

    const run = async (index: number): Promise<void> => {
      if (index >= hooks.length) {
        this.logger.debug(`[${connectionId}] Executing action: ${message.action}`);
        return this.executeAction(connectionId, message);
      }
      this.logger.debug(`[${connectionId}] Running hook ${index}/${hooks.length}`);
      await hooks[index](connection.context, message, () => run(index + 1));
    };

    try {
      await run(0);
      this.logger.debug(`[${connectionId}] Message processed successfully`);
    } catch (error: any) {
      this.logger.error(`[${connectionId}] Error in processMessage:`, error.message);
      this.logger.error(`[${connectionId}] Stack trace:`, error.stack);
      throw error;
    }
  }

  private async executeAction(connectionId: string, message: ClientMessage): Promise<void> {
    const connection = this.webSocketManager.getConnection(connectionId);
    if (!connection || !this.channel || !this.rabbitMQManager) {
      throw new Error(`Connection ${connectionId} or shared channel not available`);
    }

    const context: ActionContext = {
      connectionId,
      connection,
      subscriptionManager: this.rabbitMQManager,
      serverEmitter: this
    };

    try {
      await this.messageProcessor.executeAction(context, message);
    } catch (error: any) {
      this.logger.error(`[${connectionId}] Error in executeAction(${message.action}):`, error.message);
      this.logger.error(`[${connectionId}] Stack trace:`, error.stack);
      throw error;
    }
  }

  private async cleanup(connectionId: string): Promise<void> {
    const connection = this.webSocketManager.getConnection(connectionId);
    if (!connection) {
      this.logger.warn(`Connection ${connectionId} not found during cleanup`);
      return;
    }

    this.logger.info(`Client ${connectionId} disconnected. Cleaning up resources.`);

    if (this.rabbitMQManager) {
      await this.rabbitMQManager.cleanupSubscriptions(connection.subscriptions);
    }

    this.webSocketManager.removeConnection(connectionId);
    this.emit('client.disconnected', { connectionId });
  }

  private getHooksForAction(action: ClientMessage['action']): Hook[] {
    switch (action) {
      case 'listen':
        return [...this.hooks.pre, ...this.hooks.onListen];
      case 'unlisten':
        return [...this.hooks.pre, ...this.hooks.onUnlisten];
      case 'publish':
        return [...this.hooks.pre, ...this.hooks.onPublish];
      default:
        return this.hooks.pre;
    }
  }
}

// Export setLogLevel for testing purposes
export { setLogLevel };
