import amqplib from 'amqplib';
import http from 'http';
import promClient from 'prom-client';
import * as io from 'socket.io';

import { bundleData, unbundleData, retry } from './utils';
import * as metrics from './metrics';

promClient.collectDefaultMetrics();

type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT';
interface WebMQServerOptions {
  rmqUrl: string;
  exchange: string;
  port: number;
  host?: string;
  healthEndpoint?: string;
  metricsEndpoint?: string;
  queueTimeout?: number;
  logLevel?: LogLevel;
}
interface HealthCheckResponse {
  healthy: boolean;
  rabbitMQQueues: number;
  websockets: number;
}
interface HookContext {
  socket: io.Socket;
  sessionId: string;
  [key: string]: any;
}
interface MessageHeader {
  routingKey?: string;
  bindingKey?: string;
  rmqOptions?: amqplib.Options.Publish;
  [key: string]: JsonSerializable | amqplib.Options.Publish | undefined;
}
type HookName = 'pre' | 'wsMessage' | 'publish' | 'listen' | 'unlisten' | 'rmqMessage' | 'post';
type HookFunction = (
  header: MessageHeader,
  context: HookContext,
  rmqMessage?: amqplib.ConsumeMessage
) => Promise<MessageHeader>;

type JsonSerializable =
  | string
  | number
  | boolean
  | null
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

export { JsonSerializable, MessageHeader };

export default class WebMQServer {
  public logLevel: LogLevel = 'INFO';

  private _rmqUrl = '';
  private _exchangeName = '';
  private _port = 0;
  private _host?: string;
  private _healthEndpoint = '/health';
  private _metricsEndpoint = '/metrics';
  private _queueTimeout = 5 * 60 * 1000; // 5 minutes

  private _io: io.Server | null = null;
  private static _instances = new Set<WebMQServer>();

  private _consecutiveChannelFailures = 0;
  private _lastSuccessfulConnectionAttempt: Date | null = null;

  private _sockets = new Set<io.Socket>();
  private _queues = new Map<io.Socket, Promise<void>>();

  private _hooks = {
    pre: new Set<HookFunction>(),
    publish: new Set<HookFunction>(),
    listen: new Set<HookFunction>(),
    unlisten: new Set<HookFunction>(),
    wsMessage: new Set<HookFunction>(),
    rmqMessage: new Set<HookFunction>(),
    post: new Set<HookFunction>(),
  };

  private _consumerTags = new Map<io.Socket, string>();

  constructor(options: WebMQServerOptions) {
    this._rmqUrl = options.rmqUrl;
    this._exchangeName = options.exchange;
    this._port = options.port;
    if (options.host) this._host = options.host;
    if (options.healthEndpoint) this._healthEndpoint = options.healthEndpoint;
    if (options.metricsEndpoint) this._metricsEndpoint = options.metricsEndpoint;
    if (options.queueTimeout) this._queueTimeout = options.queueTimeout;
    if (options.logLevel) this.logLevel = options.logLevel;
  }

  public async start(): Promise<void> {
    WebMQServer._instances.add(this);
    const [channel, connection] = await this._getChannelFunc()();
    await channel.assertExchange(this._exchangeName, 'topic', { durable: true });
    const httpServer =
      this._healthEndpoint || this._metricsEndpoint
        ? http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
            if (req.url === this._healthEndpoint) {
              const health = await this._healthCheck();
              res.writeHead(health.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(health));
            } else if (req.url === this._metricsEndpoint) {
              res.writeHead(200, { 'Content-Type': promClient.register.contentType });
              res.end(await promClient.register.metrics());
            } else {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('WebSocket server - use ws:// protocol');
            }
          })
        : http.createServer();
    httpServer.listen(this._port, this._host);
    this._io = new io.Server(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      pingTimeout: 5000, // Wait 5s for pong before considering connection dead
      pingInterval: 2000, // Send ping every 2s
    });
    this._io.on('connection', async (socket) => {
      if (!socket.handshake?.auth?.sessionId) {
        this._log('WARNING', 'WebSocket connection missing sessionId, rejecting');
        socket.disconnect(true);
        return;
      }
      this._log('INFO', 'New WebSocket connection established');
      metrics.wsConnections.inc();
      const hookContext: HookContext = { socket, sessionId: socket.handshake.auth.sessionId };
      this._sockets.add(socket);
      this._queues.set(socket, Promise.resolve());
      const getChannel = this._getChannelFunc(connection);
      try {
        const [channel] = await getChannel();
        await channel.assertQueue(hookContext.sessionId, { expires: this._queueTimeout });
        const { consumerTag } = await channel.consume(
          hookContext.sessionId,
          (rmqMessage: amqplib.ConsumeMessage | null) =>
            this._handleRmqMessage(socket, rmqMessage, getChannel, hookContext)
        );
        this._log('DEBUG', `Attached consumerTag ${consumerTag} to queue ${hookContext.sessionId}`);
        this._consumerTags.set(socket, consumerTag);
        metrics.rmqConsumers.inc();
      } catch (err) {
        metrics.errors.inc({ type: 'failed_rabbitmq', action: 'consume' });
        socket.disconnect(true);
        return;
      }

      socket.on('disconnect', async (reason) =>
        this._handleDisconnect(socket, reason, hookContext, getChannel)
      );
      socket.on('listen', (data) => this._handleListen(socket, data, hookContext, getChannel));
      socket.on('unlisten', (data) => this._handleUnlisten(socket, data, hookContext, getChannel));
      socket.on('publish', (data) => this._handlePublish(socket, data, hookContext, getChannel));
    });

    this._log(
      'INFO',
      `WebMQServer started on port ${this._port}, connected to RabbitMQ at ${this._rmqUrl}`
    );
  }

  public async stop(): Promise<void> {
    // Stop **receiving** from rmq and ws
    this._sockets.forEach((socket) => {
      socket.removeAllListeners();
    });
    const [channel, connection] = await this._getChannelFunc(null)();
    await Promise.all(
      [...this._consumerTags.values()].map((consumerTag) => channel.cancel(consumerTag))
    );

    // Wait for in-flight tasks to finish
    await Promise.all([...this._queues.values()]);

    // Close everything
    this._sockets.forEach((socket) => socket.disconnect(true));
    this._io?.close();
    await channel.close();
    await connection.close();
  }

  private async _handleDisconnect(
    socket: io.Socket,
    reason: io.DisconnectReason,
    hookContext: HookContext,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>
  ) {
    const isNormalClose = reason === 'client namespace disconnect';
    this._log(
      'INFO',
      `WebSocket ${isNormalClose ? 'normal closure' : 'abnormal closure'} disconnected`
    );
    metrics.wsConnections.dec();
    try {
      let channel: amqplib.Channel;
      try {
        [channel] = await getChannel();
      } catch (err) {
        this._log('ERROR', 'Failed to get RabbitMQ channel during WebSocket close', err as Error);
        return;
      }
      this._sockets.delete(socket);
      this._queues.delete(socket);
      const consumerTag = this._consumerTags.get(socket);
      if (consumerTag) {
        await channel.cancel(consumerTag);
        this._log(
          'INFO',
          `Cancelled RabbitMQ consumer for ${hookContext.sessionId} - messages will accumulate in queue`
        );
      }
      metrics.rmqConsumers.dec();
      this._consumerTags.delete(socket);

      if (isNormalClose) {
        await channel.deleteQueue(hookContext.sessionId);
      }
    } catch (err) {
      metrics.errors.inc({ type: 'failed_rabbitmq', action: 'cleanup' });
    }

    await this._queues.get(socket); // Try to let pending tasks complete
  }

  private _handleListen(
    socket: io.Socket,
    data: any,
    hookContext: HookContext,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>
  ) {
    this._queues.set(
      socket,
      this._queues.get(socket)!.then(async () => {
        let header: MessageHeader;
        try {
          [header] = this._preprocessSocketMessage(data);
        } catch (err) {
          return;
        }
        if (!header.bindingKey) {
          metrics.errors.inc({ type: 'invalid_message_format', action: 'listen' });
          this._log('WARNING', 'Listen action missing bindingKey, ignoring');
          return;
        }
        let actualHeader: MessageHeader;
        try {
          actualHeader = await this._runHooks(
            ['pre', 'wsMessage', 'listen', 'post'],
            header,
            hookContext
          );
        } catch (error) {
          metrics.errors.inc({ type: 'hook_error', action: 'listen' });
          return;
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
          return;
        }
      })
    );
  }

  private _handleUnlisten(
    socket: io.Socket,
    data: any,
    hookContext: HookContext,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>
  ) {
    this._queues.set(
      socket,
      this._queues.get(socket)!.then(async () => {
        let header: MessageHeader;
        try {
          [header] = this._preprocessSocketMessage(data);
        } catch (err) {
          return;
        }
        if (!header.bindingKey) {
          metrics.errors.inc({ type: 'invalid_message_format', action: 'listen' });
          this._log('WARNING', 'Unlisten action missing bindingKey, ignoring');
          return;
        }
        let actualHeader: MessageHeader;
        try {
          actualHeader = await this._runHooks(
            ['pre', 'wsMessage', 'unlisten', 'post'],
            header,
            hookContext
          );
        } catch (error) {
          metrics.errors.inc({ type: 'hook_error', action: 'listen' });
          return;
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
          this._log(
            'WARNING',
            `Failed to unbind queue for session ${hookContext.sessionId}`,
            err as Error
          );
          return;
        }
      })
    );
  }

  private _handlePublish(
    socket: io.Socket,
    data: any,
    hookContext: HookContext,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>
  ) {
    this._queues.set(
      socket,
      this._queues.get(socket)!.then(async () => {
        let header: MessageHeader, payload: ArrayBuffer | undefined;
        try {
          [header, payload] = this._preprocessSocketMessage(data);
        } catch (err) {
          return;
        }
        if (!header.routingKey) {
          metrics.errors.inc({ type: 'invalid_message_format', action: 'publish' });
          this._log('WARNING', 'Publish action missing routingKey, ignoring');
          return;
        }
        let actualHeader: MessageHeader;
        try {
          actualHeader = await this._runHooks(
            ['pre', 'wsMessage', 'publish', 'post'],
            header,
            hookContext
          );
        } catch (err) {
          metrics.errors.inc({ type: 'hook_error', action: 'publish' });
          return;
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
          this._log('ERROR', 'Failed to publish message to RabbitMQ', err as Error);
          return;
        }
      })
    );
  }

  private _handleRmqMessage(
    socket: io.Socket,
    rmqMessage: amqplib.ConsumeMessage | null,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
    hookContext: HookContext
  ) {
    this._queues.set(
      socket,
      this._queues.get(socket)!.then(async () => {
        this._log('DEBUG', 'Received message from RabbitMQ');
        if (!rmqMessage) {
          metrics.errors.inc({ type: 'invalid_message_format', action: 'consume' });
          this._log('WARNING', 'Received null message from RabbitMQ, ignoring');
          return;
        }
        const [channel] = await getChannel();
        try {
          let header: MessageHeader = { routingKey: rmqMessage.fields.routingKey };
          this._log('DEBUG', `RabbitMQ message received with routing key ${header.routingKey}`);
          try {
            header = await this._runHooks(
              ['pre', 'rmqMessage', 'post'],
              header,
              hookContext,
              rmqMessage
            );
          } catch (err) {
            metrics.errors.inc({ type: 'hook_error', action: 'consume' });
            this._log('ERROR', 'Error processing RabbitMQ message through hooks', err as Error);
            throw err;
          }

          // Wait for client acknowledgment before acking RabbitMQ
          try {
            await socket
              .timeout(10000)
              .emitWithAck('message', bundleData(header, rmqMessage.content));
            channel.ack(rmqMessage);
            metrics.rmqMessagesAcked.inc({ routing_key: header.routingKey });
            this._log('DEBUG', 'Client acknowledged message delivery');
          } catch (ackErr) {
            this._log('WARNING', 'Client did not acknowledge message, requeuing', ackErr as Error);
            channel.nack(rmqMessage, false, true);
            metrics.errors.inc({ type: 'delivery_timeout', action: 'consume' });
          }
        } catch (err) {
          this._log('WARNING', 'Error processing message, requeuing', err as Error);
          channel.nack(rmqMessage, false, true);
        }
      })
    );
  }

  public addHook(hookName: HookName, hookFunction: HookFunction) {
    this._hooks[hookName].add(hookFunction);
  }

  public removeHook(hookName: HookName, hookFunction: HookFunction) {
    this._hooks[hookName].delete(hookFunction);
  }

  private async _runHooks(
    hookName: HookName | HookName[],
    header: MessageHeader,
    context: HookContext,
    rmqMessage?: amqplib.ConsumeMessage
  ): Promise<MessageHeader> {
    let result = header;
    if (!Array.isArray(hookName)) {
      for (const hook of this._hooks[hookName]) {
        result = await hook(result, context, rmqMessage);
        if (result === undefined) {
          throw new Error(`Hook ${hookName} did not return a header object`);
        }
      }
    } else {
      for (const name of hookName) {
        result = await this._runHooks(name, result, context, rmqMessage);
      }
    }
    return result;
  }

  private _getChannelFunc(
    defaultConnection: amqplib.ChannelModel | null = null
  ): () => Promise<[amqplib.Channel, amqplib.ChannelModel]> {
    let connection: amqplib.ChannelModel | null = defaultConnection;
    let channel: amqplib.Channel | null = null;
    return async () => {
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
        metrics.errors.inc({ type: 'failed_rabbitmq', action: 'channel_retrieval' });
        throw err;
      }
      return [channel, connection];
    };
  }

  private async _healthCheck(): Promise<HealthCheckResponse> {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    if (
      !this._lastSuccessfulConnectionAttempt
      || this._lastSuccessfulConnectionAttempt < oneMinuteAgo
    ) {
      try {
        const [channel, connection] = await this._getChannelFunc()();
        await channel.close();
        await connection.close();
      } catch (err) {
        this._log('ERROR', 'Health check failed to connect to RabbitMQ', err as Error);
      }
    }
    return {
      healthy: this._consecutiveChannelFailures === 0,
      rabbitMQQueues: this._consumerTags.size,
      websockets: this._sockets.size,
    };
  }

  private _preprocessSocketMessage(data: any): [any, ArrayBuffer?] {
    if (!data || !(data instanceof ArrayBuffer || Buffer.isBuffer(data))) {
      metrics.wsMessagesReceived.inc({ action: '' });
      metrics.errors.inc({ type: 'invalid_message_format', action: '' });
      this._log('WARNING', 'Received non-binary message, ignoring');
      throw new Error();
    }
    // Convert Buffer to ArrayBuffer if needed
    const arrayBuffer = Buffer.isBuffer(data)
      ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      : data;

    let header: MessageHeader, payload: ArrayBuffer | undefined;
    try {
      [header, payload] = unbundleData(arrayBuffer);
      metrics.wsMessagesReceived.inc({ action: String(header.action || '') });
    } catch (err) {
      metrics.wsMessagesReceived.inc({ action: '' });
      metrics.errors.inc({ type: 'invalid_message_format', action: '' });
      this._log('WARNING', 'Failed to unbundle incoming message, ignoring', err as Error);
      throw err;
    }
    this._log('DEBUG', `WebSocket message received: ${JSON.stringify(header)}`);
    return [header, payload];
  }

  private _log(logLevel: LogLevel, message: string | Error, err?: Error) {
    const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'SILENT'];
    const instanceLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(logLevel);
    if (messageLevelIndex >= instanceLevelIndex) {
      console.log(`[${logLevel}] ${message instanceof Error ? message.stack : message}`);
    }
    if (err) {
      this._log('DEBUG', err);
    }
  }
}

const shutdownHandler = async (signal: string) => {
  console.log(`Received ${signal}, shutting down all WebMQ servers gracefully...`);
  Array.from(WebMQServer['_instances']).map((instance) => instance.stop());
  process.exit(0);
};
process.on('SIGTERM', shutdownHandler);
process.on('SIGINT', shutdownHandler);
