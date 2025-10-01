import WebSocket, { WebSocketServer } from 'ws';
import amqplib, { Channel, ChannelModel } from 'amqplib';
import { HookFunction, runWithHooks } from './hooks';

export type ClientMessage = {
  action: 'publish' | 'listen' | 'unlisten' | 'identify';
  routingKey?: string;
  payload?: any;
  bindingKey?: string;
  sessionId?: string;
  messageId?: string;
};

export type WebMQHooks = {
  pre?: HookFunction<ClientMessage>[];
  identify?: HookFunction<ClientMessage>[];
  publish?: HookFunction<ClientMessage>[];
  listen?: HookFunction<ClientMessage>[];
  unlisten?: HookFunction<ClientMessage>[];
}

function matchesPattern(routingKey: string, bindingKey: string): boolean {
  const regexPattern = bindingKey
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*/g, '[^.]+') // * matches one or more non-dots
    .replace(/#/g, '.*');    // # matches zero or more of any character
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(routingKey);
}

/**
 * WebMQ backend server that bridges WebSocket connections with RabbitMQ message broker.
 */
export class WebMQServer {
  public logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug' = 'info';

  private _rabbitmqConnection: ChannelModel | null = null;
  private _rabbitmqChannel: Channel | null = null;
  private _wss: WebSocketServer | null = null;
  private _hooks = {
    pre: [] as HookFunction<ClientMessage>[],
    identify: [] as HookFunction<ClientMessage>[],
    publish: [] as HookFunction<ClientMessage>[],
    listen: [] as HookFunction<ClientMessage>[],
    unlisten: [] as HookFunction<ClientMessage>[]
  };

  constructor(
    private readonly rabbitmqUrl: string,
    private readonly exchangeName: string,
    hooks?: WebMQHooks
  ) {
    if (hooks) {
      this._hooks = {
        pre: hooks.pre || [],
        identify: hooks.identify || [],
        publish: hooks.publish || [],
        listen: hooks.listen || [],
        unlisten: hooks.unlisten || []
      };
    }
  }

  private _log(level: 'error' | 'warn' | 'info' | 'debug', message: string): void {
    if (this.logLevel === 'silent') return;

    const levels = ['error', 'warn', 'info', 'debug'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (messageLevelIndex <= currentLevelIndex) {
      switch (level) {
        case 'error':
          console.error(`[WebMQ ERROR] ${message}`);
          break;
        case 'warn':
          console.warn(`[WebMQ WARN] ${message}`);
          break;
        case 'info':
          console.log(`[WebMQ INFO] ${message}`);
          break;
        case 'debug':
          console.debug(`[WebMQ DEBUG] ${message}`);
          break;
      }
    }
  }

  public async start(port: number): Promise<void> {
    this._log('info', `Starting WebMQ server on port ${port}`);
    await this._getRabbitmqChannel();

    this._wss = new WebSocketServer({ port });
    this._log('info', `WebSocket server listening on port ${port}`);

    this._wss.on('connection', (ws: WebSocket) => {
      this._log('info', 'Client connected');
      const hookContext = {
        ws,
        sessionId: null as string | null,
        activeBindings: new Set<string>(),
      };
      let consumerTag: string | null = null;

      ws.on('message', async (data: WebSocket.RawData) => {
        try {
          const message: ClientMessage = JSON.parse(data.toString());
          this._log('debug', `Received message: ${message.action}`);
          switch (message.action) {
            case 'identify':
              await runWithHooks(
                hookContext,
                [...this._hooks.pre, ...this._hooks.identify],
                message,
                async () => {
                  if (!message.sessionId) {
                    throw new Error('identify requires a sessionId');
                  }

                  try {
                    hookContext.sessionId = message.sessionId; // Queue name equals sessionId
                    const channel = await this._getRabbitmqChannel();
                    await channel.assertQueue(hookContext.sessionId, { expires: 5 * 60 * 1000 });

                    consumerTag = (await channel.consume(hookContext.sessionId, (msg: any) => {
                      if (msg) {
                        // TODO: Optimize to send message once with array of matching bindingKeys
                        [...hookContext.activeBindings]
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
                }
              );
              break;
            case 'publish':
              await runWithHooks(
                hookContext,
                [...this._hooks.pre, ...this._hooks.publish],
                message,
                async () => {
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
                      ws.send(JSON.stringify({ action: 'ack', messageId: message.messageId }));
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
                }
              );
              break;
            case 'listen':
              await runWithHooks(
                hookContext,
                [...this._hooks.pre, ...this._hooks.listen],
                message,
                async () => {
                  if (!message.bindingKey) {
                    throw new Error('listen requires a bindingKey');
                  }
                  if (!hookContext.sessionId) {
                    throw new Error('Must identify with sessionId before listening');
                  }

                  if (hookContext.activeBindings.has(message.bindingKey)) {
                    return; // Already subscribed to this binding key
                  }

                  // Bind the session queue to this binding key
                  const channel = await this._getRabbitmqChannel();
                  await channel.bindQueue(
                    hookContext.sessionId, this.exchangeName, message.bindingKey
                  );

                  // Track this binding
                  hookContext.activeBindings.add(message.bindingKey);

                  // Send ack if messageId present
                  if (message.messageId) {
                    ws.send(JSON.stringify({ action: 'ack', messageId: message.messageId }));
                  }
                }
              );
              break;
            case 'unlisten':
              await runWithHooks(
                hookContext,
                [...this._hooks.pre, ...this._hooks.unlisten],
                message,
                async () => {
                  if (!message.bindingKey) {
                    throw new Error('unlisten requires a bindingKey');
                  }
                  if (!hookContext.sessionId) {
                    throw new Error('Must identify with sessionId before unlistening');
                  }

                  if (hookContext.activeBindings.has(message.bindingKey)) {
                    try {
                      const channel = await this._getRabbitmqChannel();
                      await channel.unbindQueue(
                        hookContext.sessionId,
                        this.exchangeName,
                        message.bindingKey
                      );
                    } catch (error: any) {
                      // If channel recovery fails, ignore the error during cleanup
                      // The binding will be cleaned up when the client reconnects
                    }
                    hookContext.activeBindings.delete(message.bindingKey);
                  }

                  // Send ack if messageId present
                  if (message.messageId) {
                    ws.send(JSON.stringify({ action: 'ack', messageId: message.messageId }));
                  }
                }
              );
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

            if ([1000, 1001].includes(code) && hookContext.sessionId) { // Normal closure or going away
              try {
                await channel.deleteQueue(hookContext.sessionId);
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
