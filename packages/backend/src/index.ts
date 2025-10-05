import WebSocket, { WebSocketServer } from 'ws';
import amqplib, { Channel, ChannelModel } from 'amqplib';
import { HookFunction, runWithHooks } from './hooks';

export type ClientMessage = {
  action: 'identify' | 'publish' | 'listen' | 'unlisten';
  routingKey?: string;
  payload?: any;
  bindingKey?: string;
  sessionId?: string;
  messageId?: string;
};

export type WebMQHooks = {
  pre?: HookFunction<ClientMessage>[];
  onIdentify?: HookFunction<ClientMessage>[];
  onPublish?: HookFunction<ClientMessage>[];
  onListen?: HookFunction<ClientMessage>[];
  onUnlisten?: HookFunction<ClientMessage>[];
}

/**
 * WebMQ backend server that bridges WebSocket connections with RabbitMQ message broker.
 */
export class WebMQServer {
  private static _serverInstances = new Set<WebMQServer>();

  public logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug' = 'info';

  private _rabbitmqConnection: ChannelModel | null = null;
  private _rabbitmqChannel: Channel | null = null;
  private _wss: WebSocketServer | null = null;
  private _hooks = {
    pre: [] as HookFunction<ClientMessage>[],
    onIdentify: [] as HookFunction<ClientMessage>[],
    onPublish: [] as HookFunction<ClientMessage>[],
    onListen: [] as HookFunction<ClientMessage>[],
    onUnlisten: [] as HookFunction<ClientMessage>[]
  };

  constructor(
    private readonly rabbitmqUrl: string,
    private readonly exchangeName: string,
    hooks?: WebMQHooks
  ) {
    if (hooks) {
      this._hooks = {
        pre: hooks.pre || [],
        onIdentify: hooks.onIdentify || [],
        onPublish: hooks.onPublish || [],
        onListen: hooks.onListen || [],
        onUnlisten: hooks.onUnlisten || []
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

    // Track this instance for graceful shutdown
    WebMQServer._serverInstances.add(this);

    this._wss.on('connection', (ws: WebSocket) => {
      this._log('info', 'Client connected');
      const hookContext = { ws, sessionId: null as string | null };
      let consumerTag: string | null = null;
      let messageQueue = Promise.resolve();

      ws.on('message', (data: WebSocket.RawData) => {
        return messageQueue = messageQueue.then(async () => {
          try {
            const message: ClientMessage = JSON.parse(data.toString());
            this._log('debug', `Received message: ${message.action}`);
            switch (message.action) {
              case 'identify':
                await runWithHooks(
                  hookContext,
                  [...this._hooks.pre, ...this._hooks.onIdentify],
                  message,
                  async () => {
                    if (!message.sessionId) {
                      throw new Error('identify requires a sessionId');
                    }

                    try {
                      hookContext.sessionId = message.sessionId; // Queue name equals sessionId
                      this._log('info', `Identifying client with sessionId: ${message.sessionId}`);

                      const channel = await this._getRabbitmqChannel();
                      await channel.assertQueue(hookContext.sessionId, { expires: 5 * 60 * 1000 });
                      this._log(
                        'debug',
                        `Created session queue: ${hookContext.sessionId} with 5min TTL`
                      );

                      // Check if WebSocket is still open after async operations
                      if (ws.readyState !== WebSocket.OPEN) {
                        this._log(
                          'warn',
                          `WebSocket closed during identify (readyState=${ws.readyState}), skipping consumer creation for ${hookContext.sessionId}`
                        );
                        return;
                      }

                      consumerTag = (await channel.consume(hookContext.sessionId, (msg: any) => {
                        if (msg) {
                          this._log(
                            'debug',
                            `Received message from RabbitMQ: routingKey=${msg.fields.routingKey}`
                          );

                          const payload = JSON.parse(msg.content.toString());
                          this._log(
                            'debug',
                            `Forwarding message to client ${hookContext.sessionId} with routingKey: ${msg.fields.routingKey}`,
                          );

                          try {
                            this._log('debug', `Calling ws.send() for client ${hookContext.sessionId}, ws.readyState=${ws.readyState}`);

                            if (ws.readyState !== WebSocket.OPEN) {
                              this._log(
                                'warn',
                                `Cannot send to closed socket (readyState=${ws.readyState}), nacking message for requeue: ${hookContext.sessionId}`
                              );
                              channel.nack(msg, false, true); // requeue=true
                              return;
                            }

                            ws.send(JSON.stringify({
                              action: 'message',
                              routingKey: msg.fields.routingKey,
                              payload: payload,
                            }));
                            this._log('debug', `ws.send() completed successfully for client ${hookContext.sessionId}`);
                            channel.ack(msg);
                          } catch (error: any) {
                            this._log('error', `ws.send() failed for client ${hookContext.sessionId}: ${error.message}, readyState=${ws.readyState}`);
                            channel.nack(msg, false, true); // requeue=true on error
                          }
                        }
                      })).consumerTag;

                      this._log(
                        'debug',
                        `Started consuming from queue ${hookContext.sessionId} with consumerTag: ${consumerTag}`
                      );

                      if (message.messageId) {
                        ws.send(JSON.stringify({ action: 'ack', messageId: message.messageId }));
                        this._log('debug', `Sent ack for identify message: ${message.messageId}`);
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
                  [...this._hooks.pre, ...this._hooks.onPublish],
                  message,
                  async () => {
                    if (!message.routingKey || !message.payload) {
                      throw new Error('publish requires routingKey and payload');
                    }

                    try {
                      this._log(
                        'info',
                        `Publishing message: routingKey=${message.routingKey}, sessionId=${hookContext.sessionId}`
                      );
                      this._log('debug', `Message payload: ${JSON.stringify(message.payload)}`);

                      const channel = await this._getRabbitmqChannel();
                      channel.publish(
                        this.exchangeName,
                        message.routingKey,
                        Buffer.from(JSON.stringify(message.payload))
                      );

                      this._log(
                        'debug',
                        `Message published to exchange '${this.exchangeName}' with routingKey '${message.routingKey}'`
                      );

                      // Send ack if messageId present
                      if (message.messageId) {
                        ws.send(JSON.stringify({ action: 'ack', messageId: message.messageId }));
                        this._log('debug', `Sent ack for publish message: ${message.messageId}`);
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
                  [...this._hooks.pre, ...this._hooks.onListen],
                  message,
                  async () => {
                    if (!message.bindingKey) {
                      throw new Error('listen requires a bindingKey');
                    }
                    if (!hookContext.sessionId) {
                      throw new Error('Must identify with sessionId before listening');
                    }

                    this._log(
                      'info',
                      `Client listening: bindingKey=${message.bindingKey}, sessionId=${hookContext.sessionId}`
                    );

                    // Bind the session queue to this binding key
                    const channel = await this._getRabbitmqChannel();
                    await channel.bindQueue(
                      hookContext.sessionId, this.exchangeName, message.bindingKey
                    );

                    this._log(
                      'debug',
                      `Bound queue '${hookContext.sessionId}' to exchange '${this.exchangeName}' with bindingKey '${message.bindingKey}'`
                    );

                    // Send ack if messageId present
                    if (message.messageId) {
                      ws.send(JSON.stringify({ action: 'ack', messageId: message.messageId }));
                      this._log('debug', `Sent ack for listen message: ${message.messageId}`);
                    }
                  }
                );
                break;
              case 'unlisten':
                await runWithHooks(
                  hookContext,
                  [...this._hooks.pre, ...this._hooks.onUnlisten],
                  message,
                  async () => {
                    if (!message.bindingKey) {
                      throw new Error('unlisten requires a bindingKey');
                    }
                    if (!hookContext.sessionId) {
                      throw new Error('Must identify with sessionId before unlistening');
                    }

                    this._log(
                      'info',
                      `Client unlistening: bindingKey=${message.bindingKey}, sessionId=${hookContext.sessionId}`
                    );

                    try {
                      const channel = await this._getRabbitmqChannel();
                      await channel.unbindQueue(
                        hookContext.sessionId,
                        this.exchangeName,
                        message.bindingKey
                      );
                      this._log(
                        'debug',
                        `Unbound queue '${hookContext.sessionId}' from bindingKey '${message.bindingKey}'`
                      );
                    } catch (error: any) {
                      this._log(
                        'warn',
                        `Failed to unbind queue during unlisten (ignoring): ${error.message}`
                      );
                      // If channel recovery fails, ignore the error during cleanup
                      // The binding will be cleaned up when the client reconnects
                    }

                    // Send ack if messageId present
                    if (message.messageId) {
                      ws.send(JSON.stringify({ action: 'ack', messageId: message.messageId }));
                      this._log('debug', `Sent ack for unlisten message: ${message.messageId}`);
                    }
                  }
                );
                break;
              default:
                throw new Error(`Unknown action: ${(message as any).action}`);
            }
          } catch (error: any) {
            this._log('error', `Message processing failed: ${error.message}`);

            // Send nack for failed message
            try {
              const message: ClientMessage = JSON.parse(data.toString());
              this._log(
                'debug',
                `Sending nack/error for failed message: action=${message.action}, messageId=${message.messageId}`
              );

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
              this._log(
                'error', `Failed to parse error message, sending generic error: ${parseError}`
              );
              // If we can't parse the message, send a generic error
              ws.send(JSON.stringify({ action: 'error', message: error.message }));
            }
          }
        });
      });

      ws.on('error', (error) => {
        this._log(
          'error',
          `WebSocket error: sessionId=${hookContext.sessionId || 'unknown'}, error=${error.message}`
        );
      });

      ws.on('close', async (code, reason) => {
        // TODO: Add ping/pong heartbeat mechanism to better detect network issues
        this._log(
          'info',
          `Client disconnected: sessionId=${hookContext.sessionId}, code=${code}, reason=${reason}`
        );

        if (consumerTag) {
          try {
            const channel = await this._getRabbitmqChannel();
            await channel.cancel(consumerTag);
            this._log('debug', `Cancelled consumer: ${consumerTag}`);

            if ([1000, 1001].includes(code) && hookContext.sessionId) { // Normal closure or going away
              try {
                await channel.deleteQueue(hookContext.sessionId);
                this._log(
                  'info', `Deleted session queue on normal close: ${hookContext.sessionId}`
                );
              } catch (deleteError: any) {
                this._log('debug', `Queue deletion failed (ignoring): ${deleteError.message}`);
                // Queue might not exist or already be deleted - ignore error
              }
            } else {
              this._log(
                'info',
                `Keeping session queue for potential reconnection: ${hookContext.sessionId} (TTL: 5min)`
              );
              // Note: Queue remains with TTL for potential reconnection
            }
          } catch (error: any) {
            this._log('warn', `Cleanup failed during disconnect (ignoring): ${error.message}`);
            // If channel recovery fails during cleanup, ignore the error
            // Resources will be cleaned up when connection/channel is reestablished
          }
        }
      });
    });
  }

  public async stop(): Promise<void> {
    this._log('info', 'Stopping WebMQ server...');

    // Remove from tracked instances
    WebMQServer._serverInstances.delete(this);

    // Stop WebSocket server
    if (this._wss) {
      this._wss.close();
      this._wss = null;
      this._log('debug', 'WebSocket server stopped');
    }

    // Close RabbitMQ channel and connection
    if (this._rabbitmqChannel) {
      try {
        await this._rabbitmqChannel.close();
        this._log('debug', 'RabbitMQ channel closed');
      } catch (error: any) {
        this._log('warn', `Failed to close RabbitMQ channel: ${error.message}`);
        // Channel might already be closed or failed to create
      }
      this._rabbitmqChannel = null;
    }

    if (this._rabbitmqConnection) {
      await this._rabbitmqConnection.close();
      this._log('debug', 'RabbitMQ connection closed');
      this._rabbitmqConnection = null;
    }

    this._log('info', 'WebMQ server stopped successfully');
  }

  private async _getRabbitmqChannel(): Promise<Channel> {
    if (!this._rabbitmqConnection) {
      this._log('debug', `Connecting to RabbitMQ: ${this.rabbitmqUrl}`);
      this._rabbitmqConnection = await amqplib.connect(this.rabbitmqUrl);
      this._log('info', 'RabbitMQ connection established');

      this._rabbitmqConnection.on('close', () => {
        this._log('warn', 'RabbitMQ connection closed');
        this._rabbitmqChannel = null;
        this._rabbitmqConnection = null;
      })
      this._rabbitmqConnection.on('error', (err) => {
        this._log('error', `RabbitMQ connection error: ${err.message}`);
        this._rabbitmqChannel = null;
        this._rabbitmqConnection = null;
      })
    }
    if (!this._rabbitmqChannel) {
      this._log('debug', 'Creating RabbitMQ channel');
      this._rabbitmqChannel = await this._rabbitmqConnection.createChannel();

      this._rabbitmqChannel.on('close', () => {
        this._log('warn', 'RabbitMQ channel closed');
        this._rabbitmqChannel = null;
      });

      this._rabbitmqChannel.on('error', (err) => {
        this._log('error', `RabbitMQ channel error: ${err.message}`);
        this._rabbitmqChannel = null;
      });
    }
    await this._rabbitmqChannel.assertExchange(this.exchangeName, 'topic', { durable: true });
    this._log('debug', `Exchange '${this.exchangeName}' ready (topic, durable)`);
    return this._rabbitmqChannel;
  }
}

// Register graceful shutdown handlers at module level
const shutdownHandler = async (signal: string) => {
  console.log(`Received ${signal}, shutting down all WebMQ servers gracefully...`);
  await Promise.all(
    Array.from(WebMQServer['_serverInstances']).map(server => server.stop())
  );
  process.exit(0);
};

process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
process.on('SIGINT', () => shutdownHandler('SIGINT'));
