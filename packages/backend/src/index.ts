import http from 'http';

import amqplib from 'amqplib';
import promClient from 'prom-client';
import * as ws from 'ws';

import * as metrics from './metrics';
import { bundleData, unbundleData, retry } from './utils';

// TODOs:
//   - Check whether we need to pass options to RabbitMQ

promClient.collectDefaultMetrics();

// Types
interface MessageHeader {
  action: 'identify' | 'publish' | 'listen' | 'unlisten' | 'message';
  messageId?: string;
  sessionId?: string;
  routingKey?: string;
  bindingKey?: string;
  rmqOptions?: amqplib.Options.Publish;
  [key: string]: any;
}
interface HookContext {
  ws: ws.WebSocket;
  sessionId?: string;
  [key: string]: any;
}
type HookName =
  | 'pre'
  | 'wsMessage'
  | 'identify'
  | 'publish'
  | 'listen'
  | 'unlisten'
  | 'rmqMessage'
  | 'post';
type HookFunction = (
  header: MessageHeader,
  context: HookContext,
  rmqMessage?: amqplib.ConsumeMessage
) => Promise<MessageHeader>;
type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT';
interface HealthCheckResponse {
  healthy: boolean;
  rabbitMQQueues: number;
  websockets: number;
}

interface WebMQServerOptions {
  rmqUrl: string;
  exchange: string;
  port: number;
  healthEndpoint?: string;
  metricsEndpoint?: string;
  queueTimeout?: number;
  logLevel?: LogLevel;
}

export { MessageHeader, HookContext, HookName, HookFunction };

export default class WebMQServer {
  public logLevel: LogLevel = 'INFO';

  private static _instances = new Set<WebMQServer>();
  private _queues = new Map<ws.WebSocket, Promise<void>>();
  private _webSocketServer: ws.WebSocketServer | null = null;
  private _consumerTags = new Map<ws.WebSocket, string>();
  private _webSockets = new Set<ws.WebSocket>();
  private _consecutiveChannelFailures = 0;
  private _lastSuccessfulConnectionAttempt: Date | null = null;
  private _hooks = {
    pre: new Set<HookFunction>(),
    identify: new Set<HookFunction>(),
    publish: new Set<HookFunction>(),
    listen: new Set<HookFunction>(),
    unlisten: new Set<HookFunction>(),
    wsMessage: new Set<HookFunction>(),
    rmqMessage: new Set<HookFunction>(),
    post: new Set<HookFunction>(),
  };

  // Options
  private _rmqUrl = '';
  private _exchangeName = '';
  private _port = 0;
  private _healthEndpoint = '/health';
  private _metricsEndpoint = '/metrics';
  private _queueTimeout = 5 * 60 * 1000; // 5 minutes

  constructor(options: WebMQServerOptions) {
    this._rmqUrl = options.rmqUrl;
    this._exchangeName = options.exchange;
    this._port = options.port;
    if (options.healthEndpoint) {
      this._healthEndpoint = options.healthEndpoint;
    }
    if (options.metricsEndpoint) {
      this._metricsEndpoint = options.metricsEndpoint;
    }
    if (options.queueTimeout) {
      this._queueTimeout = options.queueTimeout;
    }
    if (options.logLevel) {
      this.logLevel = options.logLevel;
    }
  }

  public async start(): Promise<void> {
    WebMQServer._instances.add(this);

    const [channel, connection] = await this._getChannelFunc()();
    await channel.assertExchange(this._exchangeName, 'topic', {
      durable: true,
    });

    if (this._healthEndpoint || this._metricsEndpoint) {
      const server = http.createServer(
        async (
          req: http.IncomingMessage,
          res: http.ServerResponse
        ): Promise<void> => {
          if (req.url === this._healthEndpoint) {
            const health = await this._healthCheck();
            res.writeHead(health.healthy ? 200 : 503, {
              'Content-Type': 'application/json',
            });
            res.end(JSON.stringify(health));
          } else if (req.url === this._metricsEndpoint) {
            res.writeHead(200, {
              'Content-Type': promClient.register.contentType,
            });
            res.end(await promClient.register.metrics());
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('WebSocket server - use ws:// protocol');
          }
        }
      );
      server.listen(this._port);
      this._webSocketServer = new ws.WebSocketServer({ server });
    } else {
      this._webSocketServer = new ws.WebSocketServer({ port: this._port });
    }

    this._webSocketServer.on('connection', async (ws: ws.WebSocket) => {
      this._log('INFO', 'New WebSocket connection established');
      metrics.wsConnections.inc();
      const hookContext: HookContext = { ws };
      this._webSockets.add(ws);
      this._queues.set(ws, Promise.resolve());
      const getChannel = this._getChannelFunc(connection);
      ws.binaryType = 'arraybuffer';

      ws.on('message', (data: ws.RawData) => {
        this._queues.set(
          ws,
          this._queues.get(ws)!.then(async () => {
            if (
              !data ||
              !(data instanceof ArrayBuffer || Buffer.isBuffer(data))
            ) {
              metrics.wsMessagesReceived.inc({ action: '' });
              metrics.errors.inc({
                type: 'invalid_message_format',
                action: '',
              });
              this._log('WARNING', 'Received non-binary message, ignoring');
              return;
            }
            let header: MessageHeader, payload: ArrayBuffer | undefined;
            try {
              [header, payload] = unbundleData(data as ArrayBuffer);
              metrics.wsMessagesReceived.inc({ action: header.action || '' });
            } catch (err) {
              metrics.wsMessagesReceived.inc({ action: '' });
              metrics.errors.inc({
                type: 'invalid_message_format',
                action: '',
              });
              this._log(
                'WARNING',
                'Failed to unbundle incoming message, ignoring',
                err as Error
              );
              return;
            }
            this._log(
              'DEBUG',
              `WebSocket message received: ${JSON.stringify(header)}`
            );
            if (!('messageId' in header)) {
              this._log(
                'WARNING',
                'Received message without messageId, ignoring'
              );
              metrics.errors.inc({
                type: 'invalid_message_format',
                action: '',
              });
              return;
            }
            try {
              switch (header.action) {
                case 'identify':
                  await this._handleIdentify(
                    header,
                    hookContext,
                    getChannel,
                    ws
                  );
                  break;
                case 'publish':
                  await this._handlePublish(
                    header,
                    hookContext,
                    getChannel,
                    payload
                  );
                  break;
                case 'listen':
                  await this._handleListen(header, hookContext, getChannel);
                  break;
                case 'unlisten':
                  await this._handleUnlisten(header, hookContext, getChannel);
                  break;
                default:
                  throw new Error(`Unknown action: ${header.action}`);
              }
              if (ws.readyState !== ws.OPEN) {
                metrics.errors.inc({ type: 'failed_websocket', action: 'ack' });
                this._log('WARNING', 'WebSocket is not open, cannot send ack');
                return;
              }
              try {
                ws.send(
                  bundleData({ action: 'ack', messageId: header.messageId })
                );
              } catch (err) {
                metrics.errors.inc({ type: 'failed_websocket', action: 'ack' });
                this._log('ERROR', 'Failed to send ack', err as Error);
                return;
              }
              metrics.wsMessagesAcked.inc({ action: header.action || '' });
            } catch (err) {
              this._log('ERROR', 'Error processing message', err as Error);
              if (ws.readyState !== ws.OPEN) {
                metrics.errors.inc({
                  type: 'failed_websocket',
                  action: 'nack',
                });
                this._log('WARNING', 'WebSocket is not open, cannot send nack');
                return;
              }
              try {
                ws.send(
                  bundleData({
                    action: 'nack',
                    messageId: header.messageId,
                    error: `${err}`,
                  })
                );
                metrics.wsMessagesNacked.inc({ action: header.action || '' });
              } catch (err) {
                this._log(
                  'ERROR',
                  'Failed to send nack to client',
                  err as Error
                );
                metrics.errors.inc({
                  type: 'failed_websocket',
                  action: 'nack',
                });
              }
            }
          })
        );
      });

      ws.on('close', async (code) => {
        // Log the disconnection
        const isNormalClose = [1000, 1001].includes(code);
        const sessionInfo = hookContext.sessionId
          ? `session ${hookContext.sessionId}`
          : 'unidentified connection';
        const closeType = isNormalClose ? 'normal closure' : 'abnormal closure';

        this._log(
          'INFO',
          `WebSocket ${sessionInfo} disconnected (code: ${code}, ${closeType})`
        );

        metrics.wsConnections.dec();
        await this._queues.get(ws); // Try to let pending tasks complete
        let channel: amqplib.Channel;
        try {
          [channel] = await getChannel();
        } catch (err) {
          this._log(
            'ERROR',
            'Failed to get RabbitMQ channel during WebSocket close',
            err as Error
          );
          return;
        }
        this._webSockets.delete(ws);
        this._queues.delete(ws);
        const consumerTag = this._consumerTags.get(ws);
        if (consumerTag) {
          await channel.cancel(consumerTag);
        }
        metrics.rmqConsumers.dec();
        this._consumerTags.delete(ws);
        if (isNormalClose && hookContext.sessionId) {
          await channel.deleteQueue(hookContext.sessionId);
        }
      });
    });

    this._log(
      'INFO',
      `WebMQServer started on port ${this._port}, connected to RabbitMQ at ${this._rmqUrl}, ` +
      `exchange ${this._exchangeName}`
    );
  }

  public async stop(): Promise<void> {
    // Stop **receiving** from rmq and ws
    this._webSockets.forEach((ws) => {
      ws.removeAllListeners('message');
    });
    const [channel, connection] = await this._getChannelFunc(null)();
    await Promise.all(
      [...this._consumerTags.values()].map((consumerTag) =>
        channel.cancel(consumerTag)
      )
    );

    // Wait for in-flight tasks to finish
    await Promise.all([...this._queues.values()]);

    // Close everything
    this._webSockets.forEach((ws) => ws.close(1001, 'Server shutting down'));
    this._webSocketServer?.close();
    await channel.close();
    await connection.close();
  }

  public addHook(hookName: HookName, hookFunction: HookFunction) {
    this._hooks[hookName].add(hookFunction);
  }

  public removeHook(hookName: HookName, hookFunction: HookFunction) {
    this._hooks[hookName].delete(hookFunction);
  }

  private async _handleIdentify(
    header: MessageHeader,
    hookContext: HookContext,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
    ws: ws.WebSocket
  ) {
    if (!header.sessionId) {
      metrics.errors.inc({
        type: 'invalid_message_format',
        action: 'identify',
      });
      throw new Error('Identify action missing sessionId');
    }
    hookContext.sessionId = header.sessionId;

    try {
      let actualHeader = await this._runHooks('pre', header, hookContext);
      actualHeader = await this._runHooks(
        'wsMessage',
        actualHeader,
        hookContext
      );
      actualHeader = await this._runHooks(
        'identify',
        actualHeader,
        hookContext
      );
      await this._runHooks('post', actualHeader, hookContext);
    } catch (err) {
      metrics.errors.inc({ type: 'hook_error', action: 'identify' });
      throw err;
    }

    const [channel] = await getChannel();
    try {
      await channel.assertQueue(hookContext.sessionId, {
        expires: this._queueTimeout,
      });
      const consume = await channel.consume(
        hookContext.sessionId,
        (rmqMessage: amqplib.ConsumeMessage | null) => {
          this._handleRmqMessage(ws, rmqMessage, getChannel, hookContext);
        }
      );
      this._consumerTags.set(ws, consume.consumerTag);
      metrics.rmqConsumers.inc();
    } catch (err) {
      metrics.errors.inc({ type: 'failed_rabbitmq', action: 'consume' });
      throw err;
    }
  }

  private async _handlePublish(
    header: MessageHeader,
    hookContext: HookContext,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
    payload?: ArrayBuffer
  ) {
    if (!header.routingKey) {
      metrics.errors.inc({ type: 'invalid_message_format', action: 'publish' });
      throw new Error('Publish action missing routingKey');
    }

    let actualHeader: MessageHeader;
    try {
      actualHeader = await this._runHooks('pre', header, hookContext);
      actualHeader = await this._runHooks(
        'wsMessage',
        actualHeader,
        hookContext
      );
      actualHeader = await this._runHooks('publish', actualHeader, hookContext);
      actualHeader = await this._runHooks('post', actualHeader, hookContext);
    } catch (err) {
      metrics.errors.inc({ type: 'hook_error', action: 'publish' });
      throw err;
    }

    const [channel] = await getChannel();
    try {
      channel.publish(
        this._exchangeName,
        actualHeader.routingKey!,
        // Convert ArrayBuffer payload to Buffer for RabbitMQ
        payload ? Buffer.from(payload) : Buffer.alloc(0),
        actualHeader.rmqOptions
      );
      metrics.wsToRmqPublishes.inc({ routing_key: actualHeader.routingKey! });
    } catch (err) {
      metrics.errors.inc({ type: 'failed_rabbitmq', action: 'publish' });
      throw err;
    }
  }

  private async _handleListen(
    header: MessageHeader,
    hookContext: HookContext,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>
  ) {
    if (!header.bindingKey) {
      metrics.errors.inc({ type: 'invalid_message_format', action: 'listen' });
      throw new Error('Listen action missing bindingKey');
    }
    if (!hookContext.sessionId) {
      metrics.errors.inc({ type: 'invalid_message_format', action: 'listen' });
      throw new Error('Listen action received before identify');
    }

    let actualHeader: MessageHeader;
    try {
      actualHeader = await this._runHooks('pre', header, hookContext);
      actualHeader = await this._runHooks(
        'wsMessage',
        actualHeader,
        hookContext
      );
      actualHeader = await this._runHooks('listen', actualHeader, hookContext);
      actualHeader = await this._runHooks('post', actualHeader, hookContext);
    } catch (err) {
      metrics.errors.inc({ type: 'hook_error', action: 'listen' });
      throw err;
    }

    const [channel] = await getChannel();
    try {
      await channel.bindQueue(
        hookContext.sessionId,
        this._exchangeName,
        actualHeader.bindingKey!
      );
      metrics.rmqBindings.inc({ binding_key: actualHeader.bindingKey! });
      this._log(
        'INFO',
        `WebSocket session ${hookContext.sessionId} bound to ${actualHeader.bindingKey}`
      );
    } catch (err) {
      metrics.errors.inc({ type: 'failed_rabbitmq', action: 'bind' });
      throw err;
    }
  }

  private async _handleUnlisten(
    header: MessageHeader,
    hookContext: HookContext,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>
  ) {
    if (!header.bindingKey) {
      metrics.errors.inc({
        type: 'invalid_message_format',
        action: 'unlisten',
      });
      throw new Error('Unlisten action missing bindingKey');
    }
    if (!hookContext.sessionId) {
      metrics.errors.inc({
        type: 'invalid_message_format',
        action: 'unlisten',
      });
      throw new Error('Unlisten action received before identify');
    }

    let actualHeader: MessageHeader;
    try {
      actualHeader = await this._runHooks('pre', header, hookContext);
      actualHeader = await this._runHooks(
        'wsMessage',
        actualHeader,
        hookContext
      );
      actualHeader = await this._runHooks(
        'unlisten',
        actualHeader,
        hookContext
      );
      actualHeader = await this._runHooks('post', actualHeader, hookContext);
    } catch (err) {
      metrics.errors.inc({ type: 'hook_error', action: 'unlisten' });
      throw err;
    }

    const [channel] = await getChannel();
    try {
      await channel.unbindQueue(
        hookContext.sessionId,
        this._exchangeName,
        actualHeader.bindingKey!
      );
      metrics.rmqBindings.dec({ binding_key: actualHeader.bindingKey! });
      this._log(
        'INFO',
        `WebSocket session ${hookContext.sessionId} unbound from ${actualHeader.bindingKey}`
      );
    } catch (err) {
      metrics.errors.inc({ type: 'failed_rabbitmq', action: 'unbind' });
      throw err;
    }
  }

  private async _handleRmqMessage(
    ws: ws.WebSocket,
    rmqMessage: amqplib.ConsumeMessage | null,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
    hookContext: HookContext
  ) {
    this._queues.set(
      ws,
      this._queues.get(ws)!.then(async () => {
        if (!rmqMessage) {
          metrics.errors.inc({
            type: 'invalid_message_format',
            action: 'consume',
          });
          this._log('WARNING', `Received null message from RabbitMQ at queue ${hookContext.sessionId}, skipping`);
          return;
        }
        const [channel] = await getChannel();
        try {
          let header: MessageHeader = {
            action: 'message',
            routingKey: rmqMessage.fields.routingKey,
          };
          this._log(
            'DEBUG',
            `RabbitMQ message received with routing key ${header.routingKey}`
          );

          try {
            header = await this._runHooks(
              'pre',
              header,
              hookContext,
              rmqMessage
            );
            header = await this._runHooks(
              'rmqMessage',
              header,
              hookContext,
              rmqMessage
            );
            header = await this._runHooks(
              'post',
              header,
              hookContext,
              rmqMessage
            );
          } catch (err) {
            metrics.errors.inc({ type: 'hook_error', action: 'consume' });
            throw err;
          }

          if (ws.readyState !== ws.OPEN) {
            metrics.errors.inc({ type: 'failed_websocket', action: 'send' });
            throw new Error('WebSocket is not open, cannot send message');
          }
          try {
            // Pass Buffer directly, bundleData handles it
            ws.send(bundleData(header, rmqMessage.content));
            metrics.rmqToWsPublishes.inc({ routing_key: header.routingKey });
          } catch (err) {
            metrics.errors.inc({ type: 'failed_websocket', action: 'send' });
            throw err;
          }
          try {
            channel.ack(rmqMessage);
            metrics.rmqMessagesAcked.inc({ routing_key: header.routingKey });
          } catch (err) {
            metrics.errors.inc({ type: 'failed_rabbitmq', action: 'ack' });
            throw err;
          }
        } catch (err) {
          this._log(
            'ERROR',
            'Error sending message to client, requeuing',
            err as Error
          );
          try {
            channel.nack(rmqMessage, false, true); // Requeue the message
            metrics.rmqMessagesNacked.inc({
              routing_key: rmqMessage.fields.routingKey,
            });
          } catch (err) {
            this._log('ERROR', 'Failed to nack message', err as Error);
          }
        }
      })
    );
  }

  private _getChannelFunc(
    defaultConnection: amqplib.ChannelModel | null = null
  ): () => Promise<[amqplib.Channel, amqplib.ChannelModel]> {
    let connection: amqplib.ChannelModel | null = defaultConnection;
    let channel: amqplib.Channel | null = null;
    return async (): Promise<[amqplib.Channel, amqplib.ChannelModel]> => {
      try {
        if (!connection) {
          connection = await retry(() => amqplib.connect(this._rmqUrl));
          connection.on('close', () => {
            channel = null;
            connection = null;
          });
        }
        if (!channel) {
          channel = await retry(() => connection!.createChannel());
          channel.on('close', () => {
            channel = null;
          });
        }
        this._consecutiveChannelFailures = 0;
        metrics.rmqConsecutiveFailures.set(this._consecutiveChannelFailures);
        this._lastSuccessfulConnectionAttempt = new Date();
      } catch (err) {
        this._log('ERROR', 'Failed to get RabbitMQ channel', err as Error);
        this._consecutiveChannelFailures++;
        metrics.rmqConsecutiveFailures.set(this._consecutiveChannelFailures);
        metrics.errors.inc({
          type: 'failed_rabbitmq',
          action: 'channel_retrieval',
        });
        throw err;
      }
      return [channel, connection];
    };
  }

  private async _healthCheck(): Promise<HealthCheckResponse> {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    if (
      !this._lastSuccessfulConnectionAttempt ||
      this._lastSuccessfulConnectionAttempt < oneMinuteAgo
    ) {
      try {
        const [channel, connection] = await this._getChannelFunc()();
        await channel.close();
        await connection.close();
      } catch (err) {
        this._log(
          'ERROR',
          'Health check failed to connect to RabbitMQ',
          err as Error
        );
      }
    }
    return {
      healthy: this._consecutiveChannelFailures === 0,
      rabbitMQQueues: this._consumerTags.size,
      websockets: this._webSockets.size,
    };
  }

  private async _runHooks(
    hookName: HookName,
    header: MessageHeader,
    context: HookContext,
    rmqMessage?: amqplib.ConsumeMessage
  ): Promise<MessageHeader> {
    const hooks = this._hooks[hookName];
    let actualHeader = header;
    for (const hook of hooks) {
      actualHeader = await hook(actualHeader, context, rmqMessage);
      if (actualHeader === undefined) {
        throw new Error(`Hook ${hookName} did not return a header object`);
      }
    }
    return actualHeader;
  }

  private _log(logLevel: LogLevel, message: string | Error, err?: Error) {
    const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'SILENT'];
    const instanceLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(logLevel);
    if (messageLevelIndex >= instanceLevelIndex) {
      console.log(
        `[${logLevel}] ${message instanceof Error ? message.stack : message}`
      );
    }
    if (err) {
      this._log('DEBUG', err);
    }
  }
}

const shutdownHandler = async (signal: string) => {
  console.log(
    `Received ${signal}, shutting down all WebMQ servers gracefully...`
  );
  Array.from(WebMQServer['_instances']).map((instance) => instance.stop());
  process.exit(0);
};
process.on('SIGTERM', shutdownHandler);
process.on('SIGINT', shutdownHandler);
