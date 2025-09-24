import WebSocket, { WebSocketServer } from 'ws';
import amqplib, { Channel, ChannelModel } from 'amqplib';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  ClientMessage,
  Hook,
  RabbitMQSubscription,
  WebSocketConnectionContext,
  WebSocketConnectionData,
} from './interfaces';


/**
 * WebMQ backend server that bridges WebSocket connections with RabbitMQ message broker.
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
  private readonly hooks: {
    pre: Hook[];
    onListen: Hook[];
    onPublish: Hook[];
    onUnlisten: Hook[];
  };
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WebSocketConnectionData>();

  public logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug' = 'error';

  constructor({
    rabbitmqUrl,
    exchangeName,
    hooks = {}
  }: {
    rabbitmqUrl: string;
    exchangeName: string;
    hooks?: {
      pre?: Hook[];
      onListen?: Hook[];
      onPublish?: Hook[];
      onUnlisten?: Hook[];
    };
  }) {
    super();
    this.rabbitmqUrl = rabbitmqUrl;
    this.exchangeName = exchangeName;
    this.hooks = {
      pre: hooks.pre || [],
      onListen: hooks.onListen || [],
      onPublish: hooks.onPublish || [],
      onUnlisten: hooks.onUnlisten || [],
    };
  }

  private log(level: 'error' | 'warn' | 'info' | 'debug', ...args: any[]): void {
    const levels = ['silent', 'error', 'warn', 'info', 'debug'];
    if (levels.indexOf(this.logLevel) >= levels.indexOf(level) && this.logLevel !== 'silent') {
      if (level === 'debug') console.debug(...args);
      else if (level === 'error') console.error(...args);
      else if (level === 'warn') console.warn(...args);
      else console.log(...args); // info
    }
  }

  public async start(port: number): Promise<void> {
    this.log('info', 'Starting WebMQ Backend...');

    // Establish RabbitMQ connection and shared channel
    this.connection = await amqplib.connect(this.rabbitmqUrl);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(this.exchangeName, 'topic', {
      durable: true,
    });

    this.log('info', 'RabbitMQ connection and shared channel established');

    // Start WebSocket server (inlined)
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.log('info', `WebMQ Backend started on ws://localhost:${port}`);

    // Add error handler to prevent unhandled error crashes
    this.on('error', (errorEvent) => {
      this.log('error', 'WebMQ Backend error event:', errorEvent);
      // Don't re-throw, just log it
    });
  }

  public async stop(): Promise<void> {
    this.log('info', 'Stopping WebMQ Backend...');

    // Stop WebSocket server
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

    this.log('info', 'WebMQ Backend stopped');
  }

  private handleConnection(ws: WebSocket): void {
    const connectionId = crypto.randomUUID();
    const context: WebSocketConnectionContext = { ws, id: connectionId };
    const subscriptions = new Map<string, RabbitMQSubscription>();

    this.connections.set(connectionId, { ws, subscriptions, context });

    this.log('info', `Client ${connectionId} connected.`);
    this.emit('client.connected', { connectionId });

    // RabbitMQ operations as closures (old-school approach)
    const subscribe = async (bindingKey: string, messageHandler: (msg: any) => void): Promise<RabbitMQSubscription> => {
      const { queue } = await this.channel!.assertQueue('', {
        exclusive: true,
        autoDelete: true,
      });

      await this.channel!.bindQueue(queue, this.exchangeName, bindingKey);

      const { consumerTag } = await this.channel!.consume(queue, (msg) => {
        if (msg) {
          messageHandler(msg);
          this.channel!.ack(msg);
        }
      });

      return { queue, consumerTag };
    };

    const unsubscribe = async (subscription: RabbitMQSubscription, bindingKey: string): Promise<void> => {
      // Check if channel is still open before attempting cleanup
      if (
        !this.channel ||
        (this.channel as any).closing ||
        (this.channel as any).closed
      ) {
        return; // Channel is already closed, nothing to clean up
      }

      try {
        // Cancel consumer first - this will trigger autoDelete for the queue
        await this.channel.cancel(subscription.consumerTag);
        // Unbind queue from exchange for clean shutdown
        await this.channel.unbindQueue(
          subscription.queue,
          this.exchangeName,
          bindingKey
        );
        // Note: Queue deletion is handled automatically by autoDelete when last consumer is removed
      } catch (error: any) {
        // If channel was closed during cleanup, ignore the error
        if (
          error.message?.includes('Channel closed') ||
          error.message?.includes('Channel closing') ||
          error.message?.includes('IllegalOperationError')
        ) {
          return;
        }
        throw error; // Re-throw other errors
      }
    };

    const publish = async (routingKey: string, payload: any): Promise<void> => {
      this.channel!.publish(
        this.exchangeName,
        routingKey,
        Buffer.from(JSON.stringify(payload))
      );
    };

    const cleanupSubscriptions = async (): Promise<void> => {
      for (const [bindingKey, subscription] of subscriptions.entries()) {
        try {
          await unsubscribe(subscription, bindingKey);
        } catch (err) {
          // Log cleanup errors - these are usually harmless during shutdown
          this.log('debug',
            `Error cleaning up subscription for ${bindingKey}:`,
            err
          );
        }
      }
    };

    // Store RabbitMQ operations in the connection data for access in action handlers
    (this.connections.get(connectionId) as any).rabbitMQOps = {
      subscribe,
      unsubscribe,
      publish,
      cleanupSubscriptions
    };

    // Set up WebSocket event handlers
    ws.on('message', async (data: WebSocket.RawData) => {
      await this.handleMessage(connectionId, ws, data);
    });

    ws.on('close', async () => {
      await this.handleClose(connectionId);
    });
  }

  private async handleMessage(
    connectionId: string,
    ws: WebSocket,
    data: WebSocket.RawData
  ): Promise<void> {
    try {
      const message: ClientMessage = JSON.parse(data.toString());

      this.emit('message.received', { connectionId, message });

      await this.processMessage(connectionId, message);

      this.emit('message.processed', { connectionId, message });
    } catch (error: any) {
      this.log('error',
        `[${connectionId}] Error processing message:`,
        error.message
      );

      this.emit('error', {
        connectionId,
        error,
        context: 'message processing',
      });

      // Send nack for failed message
      try {
        const message: ClientMessage = JSON.parse(data.toString());
        if (message.action === 'publish' && message.messageId) {
          ws.send(
            JSON.stringify({
              action: 'nack',
              messageId: message.messageId,
              error: error.message,
            })
          );
          this.log('debug',
            `[${connectionId}] Sent nack for message ${message.messageId}`
          );
        } else {
          ws.send(JSON.stringify({ action: 'error', message: error.message }));
        }
      } catch (parseError) {
        // If we can't parse the message, send a generic error
        ws.send(JSON.stringify({ action: 'error', message: error.message }));
      }
    }
  }

  private async handleClose(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    // Use closure-based cleanup
    const rabbitMQOps = (connection as any).rabbitMQOps;
    if (rabbitMQOps) {
      await rabbitMQOps.cleanupSubscriptions();
    }

    this.connections.delete(connectionId);
    this.emit('client.disconnected', { connectionId });
    this.log('info', `Client ${connectionId} disconnected.`);
  }

  private async processMessage(
    connectionId: string,
    message: ClientMessage
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    this.log('debug',
      `[${connectionId}] Processing message:`,
      JSON.stringify(message)
    );

    const hooks = this.getHooksForAction(message.action);

    const run = async (index: number): Promise<void> => {
      if (index >= hooks.length) {
        this.log('debug',
          `[${connectionId}] Executing action: ${message.action}`
        );
        return this.executeAction(connectionId, message);
      }
      this.log('debug',
        `[${connectionId}] Running hook ${index}/${hooks.length}`
      );
      await hooks[index](connection.context, message, () => run(index + 1));
    };

    try {
      await run(0);
      this.log('debug', `[${connectionId}] Message processed successfully`);
    } catch (error: any) {
      this.log('error',
        `[${connectionId}] Error in processMessage:`,
        error.message
      );
      this.log('error', `[${connectionId}] Stack trace:`, error.stack);
      throw error;
    }
  }

  private async executeAction(
    connectionId: string,
    message: ClientMessage
  ): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection || !this.channel) {
      throw new Error(
        `Connection ${connectionId} or shared channel not available`
      );
    }

    // Get closure-based RabbitMQ operations
    const rabbitMQOps = (connection as any).rabbitMQOps;
    if (!rabbitMQOps) {
      throw new Error(`RabbitMQ operations not available for connection ${connectionId}`);
    }

    this.log('debug',
      `[${connectionId}] Executing ${message.action} action`
    );

    try {
      // Action handlers as arrow functions (old-school approach)
      const handlePublish = async (): Promise<void> => {
        if (message.action !== 'publish') {
          throw new Error('Expected publish message');
        }
        if (!message.routingKey || !message.payload) {
          throw new Error('publish requires routingKey and payload');
        }

        try {
          await rabbitMQOps.publish(message.routingKey, message.payload);
          this.log('debug', `[${connectionId}] Message published successfully`);

          // Send ack if messageId present
          if (message.messageId) {
            connection.ws.send(JSON.stringify({
              action: 'ack',
              messageId: message.messageId,
              status: 'success'
            }));
            this.log('debug', `[${connectionId}] Sent ack for message ${message.messageId}`);
          }
        } catch (error: any) {
          this.log('error', `[${connectionId}] Error publishing message:`, error.message);

          // Send nack if messageId present
          if (message.messageId) {
            connection.ws.send(JSON.stringify({
              action: 'nack',
              messageId: message.messageId,
              error: error.message
            }));
            this.log('debug', `[${connectionId}] Sent nack for message ${message.messageId}`);
          }
          throw error;
        }
      };

      const handleListen = async (): Promise<void> => {
        if (message.action !== 'listen') {
          throw new Error('Expected listen message');
        }
        if (!message.bindingKey) {
          throw new Error('listen requires a bindingKey');
        }

        if (connection.subscriptions.has(message.bindingKey)) {
          this.log('debug', `[${connectionId}] Already listening to ${message.bindingKey}`);
          return;
        }

        const subscription = await rabbitMQOps.subscribe(
          message.bindingKey,
          (msg: any) => {
            this.log('debug', `[${connectionId}] Received message from RabbitMQ:`, msg.content.toString());
            connection.ws.send(JSON.stringify({
              action: 'message',
              bindingKey: message.bindingKey,
              payload: JSON.parse(msg.content.toString()),
            }));
          }
        );

        this.log('debug', `[${connectionId}] Queue created: ${subscription.queue}`);
        connection.subscriptions.set(message.bindingKey, subscription);
        this.log('debug', `[${connectionId}] Consumer set up with tag: ${subscription.consumerTag}`);

        // Emit subscription created event
        this.emit('subscription.created', {
          connectionId,
          bindingKey: message.bindingKey,
          queue: subscription.queue,
        });
      };

      const handleUnlisten = async (): Promise<void> => {
        if (message.action !== 'unlisten') {
          throw new Error('Expected unlisten message');
        }
        if (!message.bindingKey) {
          throw new Error('unlisten requires a bindingKey');
        }

        const subscription = connection.subscriptions.get(message.bindingKey);
        if (subscription) {
          await rabbitMQOps.unsubscribe(subscription, message.bindingKey);
          connection.subscriptions.delete(message.bindingKey);
          this.log('debug', `[${connectionId}] Unsubscribed from ${message.bindingKey}`);

          // Emit subscription removed event
          this.emit('subscription.removed', {
            connectionId,
            bindingKey: message.bindingKey,
          });
        } else {
          this.log('debug', `[${connectionId}] No subscription found for ${message.bindingKey}`);
        }
      };

      const handleIdentify = async (): Promise<void> => {
        if (message.action !== 'identify') {
          throw new Error('Expected identify message');
        }
        if (!message.sessionId) {
          throw new Error('identify requires a sessionId');
        }

        // Store sessionId in connection context for potential future use
        connection.context.sessionId = message.sessionId;
        this.log('debug', `[${connectionId}] Client identified with session ID: ${message.sessionId}`);

        // Emit client identified event
        this.emit('client.identified', {
          connectionId,
          sessionId: message.sessionId,
        });
      };

      // Execute action based on message type
      switch (message.action) {
        case 'publish':
          await handlePublish();
          break;
        case 'listen':
          await handleListen();
          break;
        case 'unlisten':
          await handleUnlisten();
          break;
        case 'identify':
          await handleIdentify();
          break;
        default:
          throw new Error(`Unknown action: ${(message as any).action}`);
      }

      this.log('debug', `[${connectionId}] Action ${message.action} completed successfully`);
    } catch (error: any) {
      this.log('error',
        `[${connectionId}] Error in executeAction(${message.action}):`,
        error.message
      );
      this.log('error', `[${connectionId}] Stack trace:`, error.stack);
      throw error;
    }
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
