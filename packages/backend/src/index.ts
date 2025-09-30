import WebSocket, { WebSocketServer } from 'ws';
import amqplib, { Channel, ChannelModel } from 'amqplib';

function matchesPattern(routingKey: string, bindingKey: string): boolean {
  const regexPattern = bindingKey
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*/g, '[^.]+') // * matches one or more non-dots
    .replace(/#/g, '.*');    // # matches zero or more of any character
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(routingKey);
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

  constructor(
    private readonly rabbitmqUrl: string,
    private readonly exchangeName: string
  ) { }

  public async start(port: number): Promise<void> {
    // Initialize channel through getter to set up auto-recovery
    await this._getRabbitmqChannel();

    this._wss = new WebSocketServer({ port });
    this._wss.on('connection', (ws: WebSocket) => {
      let sessionId: string | null = null;
      let consumerTag: string | null = null;
      const activeBindings = new Set<string>();

      ws.on('message', async (data: WebSocket.RawData) => {
        try {
          const message: ClientMessage = JSON.parse(data.toString());
          switch (message.action) {
            case 'identify':
              if (!message.sessionId) {
                throw new Error('identify requires a sessionId');
              }

              try {
                sessionId = message.sessionId; // Queue name equals sessionId
                const channel = await this._getRabbitmqChannel();
                await channel.assertQueue(sessionId, { expires: 5 * 60 * 1000 });

                consumerTag = (await channel.consume(sessionId, (msg: any) => {
                  if (msg) {
                    // TODO: Optimize to send message once with array of matching bindingKeys
                    [...activeBindings]
                      .filter(bindingKey => matchesPattern(msg.fields.routingKey, bindingKey))
                      .forEach(bindingKey => {
                        ws.send(JSON.stringify({
                          action: 'message',
                          bindingKey: bindingKey,
                          payload: JSON.parse(msg.content.toString()),
                        }));
                      });

                    channel.ack(msg);
                  }
                })).consumerTag;

                if (message.messageId) {
                  ws.send(JSON.stringify({ action: 'ack', messageId: message.messageId }));
                }
              } catch (error: any) {
                if (message.messageId) {
                  ws.send(JSON.stringify({
                    action: 'nack',
                    messageId: message.messageId,
                    error: error.message
                  }));
                }
                throw error;
              }
              break;
            case 'publish':
              if (!message.routingKey || !message.payload) {
                throw new Error('publish requires routingKey and payload');
              }

              try {
                const channel = await this._getRabbitmqChannel();
                channel.publish(
                  this.exchangeName,
                  message.routingKey,
                  Buffer.from(JSON.stringify(message.payload))
                );

                // Send ack if messageId present
                if (message.messageId) {
                  ws.send(JSON.stringify({
                    action: 'ack',
                    messageId: message.messageId,
                    status: 'success'
                  }));
                }
              } catch (error: any) {
                // Send nack if messageId present
                if (message.messageId) {
                  ws.send(JSON.stringify({
                    action: 'nack',
                    messageId: message.messageId,
                    error: error.message
                  }));
                }
                throw error;
              }
              break;
            case 'listen':
              if (!message.bindingKey) {
                throw new Error('listen requires a bindingKey');
              }
              if (!sessionId) {
                throw new Error('Must identify with sessionId before listening');
              }

              if (activeBindings.has(message.bindingKey)) {
                break; // Already subscribed to this binding key
              }

              // Bind the session queue to this binding key
              const channel = await this._getRabbitmqChannel();
              await channel.bindQueue(
                sessionId, this.exchangeName, message.bindingKey
              );

              // Track this binding
              activeBindings.add(message.bindingKey);
              break;
            case 'unlisten':
              if (!message.bindingKey) {
                throw new Error('unlisten requires a bindingKey');
              }

              if (!sessionId) {
                throw new Error('Must identify with sessionId before unlistening');
              }

              if (activeBindings.has(message.bindingKey)) {
                try {
                  const channel = await this._getRabbitmqChannel();
                  await channel.unbindQueue(
                    sessionId,
                    this.exchangeName,
                    message.bindingKey
                  );
                } catch (error: any) {
                  // If channel recovery fails, ignore the error during cleanup
                  // The binding will be cleaned up when the client reconnects
                }
                activeBindings.delete(message.bindingKey);
              }
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
      });

      ws.on('close', async (code, reason) => {
        // TODO: Add ping/pong heartbeat mechanism to better detect network issues
        if (consumerTag) {
          try {
            const channel = await this._getRabbitmqChannel();
            await channel.cancel(consumerTag);

            if ([1000, 1001].includes(code) && sessionId) { // Normal closure or going away
              try {
                await channel.deleteQueue(sessionId);
              } catch (deleteError: any) {
                // Queue might not exist or already be deleted - ignore error
              }
            } else {
              // Note: Queue remains with TTL for potential reconnection
            }
          } catch (error: any) {
            // If channel recovery fails during cleanup, ignore the error
            // Resources will be cleaned up when connection/channel is reestablished
          }
        }
      });
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
      try {
        await this._rabbitmqChannel.close();
      } catch (error) {
        // Channel might already be closed or failed to create
      }
      this._rabbitmqChannel = null;
    }

    if (this._rabbitmqConnection) {
      await this._rabbitmqConnection.close();
      this._rabbitmqConnection = null;
    }
  }

  private async _getRabbitmqChannel(): Promise<Channel> {
    if (!this._rabbitmqConnection) {
      this._rabbitmqConnection = await amqplib.connect(this.rabbitmqUrl);
      this._rabbitmqConnection.on('close', () => {
        this._rabbitmqChannel = null;
        this._rabbitmqConnection = null;
      })
      this._rabbitmqConnection.on('error', () => {
        this._rabbitmqChannel = null;
        this._rabbitmqConnection = null;
      })
    }
    if (!this._rabbitmqChannel) {
      this._rabbitmqChannel = await this._rabbitmqConnection.createChannel();

      this._rabbitmqChannel.on('close', () => {
        this._rabbitmqChannel = null;
      });

      this._rabbitmqChannel.on('error', () => {
        this._rabbitmqChannel = null;
      });
    }
    await this._rabbitmqChannel.assertExchange(this.exchangeName, 'topic', { durable: true });
    return this._rabbitmqChannel;
  }
}
