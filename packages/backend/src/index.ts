import WebSocket, { WebSocketServer } from 'ws';
import amqplib, { Channel, ChannelModel } from 'amqplib';
import crypto from 'crypto';

// Inlined interfaces
interface RabbitMQSubscription {
  queue: string;
  consumerTag: string;
}

export interface WebSocketConnectionData {
  ws: WebSocket;
  subscriptions: Map<string, RabbitMQSubscription>;
  subscribe: (bindingKey: string, messageHandler: (msg: any) => void) => Promise<void>;
  unsubscribe: (subscription: RabbitMQSubscription, bindingKey: string) => Promise<void>;
  publish: (routingKey: string, payload: any) => Promise<void>;
  cleanupSubscriptions: () => Promise<void>;
}

export type ClientMessage = {
  action: 'publish' | 'listen' | 'unlisten' | 'identify';
  routingKey?: string;
  payload?: any;
  bindingKey?: string;
  sessionId?: string;
  messageId?: string;
};

/**
 * WebMQ backend server that bridges WebSocket connections with RabbitMQ message broker.
 */
export class WebMQServer {
  private _rabbitmqConnection: ChannelModel | null = null;
  private _rabbitmqChannel: Channel | null = null;
  private _wss: WebSocketServer | null = null;
  private _websocketConnections = new Map<string, WebSocketConnectionData>();

  constructor(
    private readonly _rabbitmqUrl: string,
    private readonly _exchangeName: string
  ) {
  }

  public async start(port: number): Promise<void> {
    // Establish RabbitMQ connection and shared channel
    this._rabbitmqConnection = await amqplib.connect(this._rabbitmqUrl);
    this._rabbitmqChannel = await this._rabbitmqConnection.createChannel();
    await this._rabbitmqChannel.assertExchange(this._exchangeName, 'topic', {
      durable: true,
    });

    // Start WebSocket server (inlined)
    this._wss = new WebSocketServer({ port });
    this._wss.on('connection', (ws: WebSocket) => {
      this._handleWebsocketConnection(ws);
    });
  }

  private _handleWebsocketConnection(ws: WebSocket): void {
    const connectionId = crypto.randomUUID();
    const subscriptions = new Map<string, RabbitMQSubscription>();

    // Store connection data with RabbitMQ operations as siblings
    this._websocketConnections.set(connectionId, {
      ws,
      subscriptions,
      subscribe: async (bindingKey: string, messageHandler: (msg: any) => void): Promise<void> => {
        if (subscriptions.has(bindingKey)) {
          return; // Already subscribed to this binding key
        }

        const { queue } = await this._rabbitmqChannel!.assertQueue('', {
          exclusive: true,
          autoDelete: true,
        });

        await this._rabbitmqChannel!.bindQueue(queue, this._exchangeName, bindingKey);

        const { consumerTag } = await this._rabbitmqChannel!.consume(queue, (msg: any) => {
          if (msg) {
            messageHandler(msg);
            this._rabbitmqChannel!.ack(msg);
          }
        });

        subscriptions.set(bindingKey, { queue, consumerTag });
      },
      unsubscribe: async (subscription: RabbitMQSubscription, bindingKey: string): Promise<void> => {
        // Check if channel is still open before attempting cleanup
        if (
          !this._rabbitmqChannel ||
          (this._rabbitmqChannel as any).closing ||
          (this._rabbitmqChannel as any).closed
        ) {
          return; // Channel is already closed, nothing to clean up
        }

        try {
          // Cancel consumer first - this will trigger autoDelete for the queue
          await this._rabbitmqChannel.cancel(subscription.consumerTag);
          // Unbind queue from exchange for clean shutdown
          await this._rabbitmqChannel.unbindQueue(
            subscription.queue,
            this._exchangeName,
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
      },
      publish: async (routingKey: string, payload: any): Promise<void> => {
        this._rabbitmqChannel!.publish(
          this._exchangeName,
          routingKey,
          Buffer.from(JSON.stringify(payload))
        );
      },
      cleanupSubscriptions: async (): Promise<void> => {
        const connection = this._websocketConnections.get(connectionId);
        if (!connection) return;

        for (const [bindingKey, subscription] of subscriptions.entries()) {
          try {
            await connection.unsubscribe(subscription, bindingKey);
          } catch (err) {
            // Log cleanup errors - these are usually harmless during shutdown
            // Error cleaning up subscription
          }
        }
      }
    });

    // Set up WebSocket event handlers
    ws.on('message', async (data: WebSocket.RawData) => {
      await this._handleWebsocketMessage(connectionId, ws, data);
    });

    ws.on('close', async () => {
      await this._handleWebsocketClose(connectionId);
    });
  }

  public async stop(): Promise<void> {
    // Stop WebSocket server
    if (this._wss) {
      this._wss.close();
      this._wss = null;
    }

    // Close RabbitMQ channel and connection
    if (this._rabbitmqChannel) {
      await this._rabbitmqChannel.close();
      this._rabbitmqChannel = null;
    }

    if (this._rabbitmqConnection) {
      await this._rabbitmqConnection.close();
      this._rabbitmqConnection = null;
    }
  }

  private async _handleWebsocketMessage(
    connectionId: string,
    ws: WebSocket,
    data: WebSocket.RawData
  ): Promise<void> {
    try {
      const message: ClientMessage = JSON.parse(data.toString());
      const websocketConnection = this._websocketConnections.get(connectionId);
      if (!websocketConnection || !this._rabbitmqChannel) {
        throw new Error(
          `Connection ${connectionId} or shared channel not available`
        );
      }

      // Action handlers as arrow functions (old-school approach)
      const handlePublish = async (): Promise<void> => {
        if (message.action !== 'publish') {
          throw new Error('Expected publish message');
        }
        if (!message.routingKey || !message.payload) {
          throw new Error('publish requires routingKey and payload');
        }

        try {
          await websocketConnection.publish(message.routingKey, message.payload);

          // Send ack if messageId present
          if (message.messageId) {
            websocketConnection.ws.send(JSON.stringify({
              action: 'ack',
              messageId: message.messageId,
              status: 'success'
            }));
          }
        } catch (error: any) {

          // Send nack if messageId present
          if (message.messageId) {
            websocketConnection.ws.send(JSON.stringify({
              action: 'nack',
              messageId: message.messageId,
              error: error.message
            }));
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

        await websocketConnection.subscribe(
          message.bindingKey,
          (msg: any) => {
            websocketConnection.ws.send(JSON.stringify({
              action: 'message',
              bindingKey: message.bindingKey,
              payload: JSON.parse(msg.content.toString()),
            }));
          }
        );

      };

      const handleUnlisten = async (): Promise<void> => {
        if (message.action !== 'unlisten') {
          throw new Error('Expected unlisten message');
        }
        if (!message.bindingKey) {
          throw new Error('unlisten requires a bindingKey');
        }

        const subscription = websocketConnection.subscriptions.get(message.bindingKey);
        if (subscription) {
          await websocketConnection.unsubscribe(subscription, message.bindingKey);
          websocketConnection.subscriptions.delete(message.bindingKey);

        } else {
        }
      };

      const handleIdentify = async (): Promise<void> => {
        if (message.action !== 'identify') {
          throw new Error('Expected identify message');
        }
        if (!message.sessionId) {
          throw new Error('identify requires a sessionId');
        }

        try {
          // Note: sessionId received but not stored since we don't have hooks/context anymore

          // Send ack if messageId present
          if (message.messageId) {
            websocketConnection.ws.send(JSON.stringify({
              action: 'ack',
              messageId: message.messageId
            }));
          }

          // Emit client identified event
        } catch (error: any) {

          // Send nack if messageId present
          if (message.messageId) {
            websocketConnection.ws.send(JSON.stringify({
              action: 'nack',
              messageId: message.messageId,
              error: error.message
            }));
          }
          throw error;
        }
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
    } catch (error: any) {
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
        } else {
          ws.send(JSON.stringify({ action: 'error', message: error.message }));
        }
      } catch (parseError) {
        // If we can't parse the message, send a generic error
        ws.send(JSON.stringify({ action: 'error', message: error.message }));
      }
    }
  }

  private async _handleWebsocketClose(connectionId: string): Promise<void> {
    const websocketConnection = this._websocketConnections.get(connectionId);
    if (!websocketConnection) {
      return;
    }

    // Use closure-based cleanup
    await websocketConnection.cleanupSubscriptions();

    this._websocketConnections.delete(connectionId);
  }

}
