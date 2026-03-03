import http from 'http';

import amqplib from 'amqplib';
import ws from 'ws';

// TODOs:
//   - Metrics

type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'SILENT';
type HookName =
  'pre' | 'identify' | 'publish' | 'listen' | 'unlisten' | 'wsMessage' | 'rmqMessage' | 'post';
type HookFunction = (header: MessageHeader, context: any, rmqMessage?: amqplib.ConsumeMessage) => Promise<any>;

interface MessageHeader {
  action: 'identify' | 'publish' | 'listen' | 'unlisten' | 'message';
  messageId?: string;
  sessionId?: string;
  routingKey?: string;
  bindingKey?: string;
  rmqHeaders?: any;
};

export default class WebMQServer {
  private static _instances = new Set<WebMQServer>();
  public logLevel: LogLevel = 'INFO';
  private _queues = new Map<ws.WebSocket, Promise<void>>();
  private _webSocketServer: ws.WebSocketServer | null = null;
  private _consumerTags = new Map<ws.WebSocket, string>();
  private _webSockets = new Set<ws.WebSocket>();
  private _consecutiveChannelFailures = 0;
  private _lastSuccessfulConnectionAttempt: Date | null = null;
  private _hooks = {
    'pre': new Set<HookFunction>(),
    'identify': new Set<HookFunction>(),
    'publish': new Set<HookFunction>(),
    'listen': new Set<HookFunction>(),
    'unlisten': new Set<HookFunction>(),
    'wsMessage': new Set<HookFunction>(),
    'rmqMessage': new Set<HookFunction>(),
    'post': new Set<HookFunction>(),
  };

  // Options
  private _rmqUrl = '';
  private _exchangeName = '';
  private _port = 0;
  private _healthEndpoint = '';
  private _queueTimeout = 5 * 60 * 1000; // 5 minutes

  constructor({
    rmqUrl, exchange, port, healthEndpoint = '', queueTimeout = 5 * 60 * 1000
  }: {
    rmqUrl: string,
    exchange: string,
    port: number,
    healthEndpoint?: string,
    queueTimeout?: number
  }) {
    this._rmqUrl = rmqUrl;
    this._exchangeName = exchange;
    this._port = port;
    this._healthEndpoint = healthEndpoint;
    this._queueTimeout = queueTimeout;
  }

  public async start(): Promise<void> {
    WebMQServer._instances.add(this);

    const [channel, connection] = await this._getChannelFunc()();
    await channel.assertExchange(
      this._exchangeName, 'topic', { durable: true }
    );

    if (this._healthEndpoint) {
      const server = http.createServer(async (req, res) => {
        if (req.url === this._healthEndpoint) {
          const health = await this._healthCheck();
          res.writeHead(health.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('WebSocket server - use ws:// protocol');
        }
      });
      server.listen(this._port);
      this._webSocketServer = new ws.WebSocketServer({ server });
    } else {
      this._webSocketServer = new ws.WebSocketServer({ port: this._port });
    }

    this._webSocketServer.on('connection', async (ws: ws.WebSocket) => {
      const hookContext: any = { ws };
      this._webSockets.add(ws);
      this._queues.set(ws, Promise.resolve());
      const getChannel = this._getChannelFunc(connection);
      ws.binaryType = 'arraybuffer';

      ws.on('message', (data: ws.RawData) => {
        this._queues.set(ws, this._queues.get(ws)!.then(async () => {
          let header: MessageHeader, payload: ArrayBuffer | undefined;
          if (!data || !(data instanceof ArrayBuffer || Buffer.isBuffer(data))) {
            this._log('WARNING', 'Received non-binary message, ignoring');
            return;
          }
          try {
            [header, payload] = unbundleData(data as ArrayBuffer);
          } catch (err) {
            this._log('ERROR', 'Failed to unbundle incoming message, ignoring', err as Error);
            return;
          }
          if (!('messageId' in header)) {
            this._log('WARNING', 'Received message without messageId, ignoring');
            return;
          }
          let channel: amqplib.Channel;
          try {
            [channel] = await getChannel();
          } catch (err) {
            this._log('ERROR', 'Failed to get RabbitMQ channel', err as Error);
            return;
          }
          try {
            switch (header.action) {
              case 'identify':
                await this._handleIdentify(header, hookContext, getChannel, ws);
                break;
              case 'publish':
                await this._handlePublish(header, hookContext, getChannel, payload);
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
            ws.send(bundleData({ action: 'ack', messageId: header.messageId }));
          } catch (err) {
            this._log('ERROR', 'Error processing message', err as Error);
            try {
              ws.send(bundleData({ action: 'nack', messageId: header.messageId, error: `${err}` }));
            } catch (err) {
              this._log('ERROR', 'Failed to send nack to client', err as Error);
            }
          }
        }));
      });

      ws.on('close', async (code) => {
        await this._queues.get(ws);  // Try to let pending tasks complete
        let channel: amqplib.Channel;
        try {
          [channel] = await getChannel();
        } catch (err) {
          this._log('ERROR', 'Failed to get RabbitMQ channel during WebSocket close', err as Error);
          return;
        }
        this._webSockets.delete(ws);
        this._queues.delete(ws);
        const consumerTag = this._consumerTags.get(ws);
        consumerTag && await channel.cancel(consumerTag);
        this._consumerTags.delete(ws);
        if ([1000, 1001].includes(code) && hookContext.sessionId) {  // Normal closure or going away
          await channel.deleteQueue(hookContext.sessionId);
        }
      });
    });
  }

  public async stop() {
    // Stop **receiving** from rmq and ws
    this._webSockets.forEach((ws) => {
      ws.removeAllListeners('message');
    });
    const [channel, connection] = await this._getChannelFunc(null)();
    await Promise.all([...this._consumerTags.values()].map(
      (consumerTag) => channel.cancel(consumerTag)
    ));

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
    hookContext: any,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
    ws: ws.WebSocket
  ) {
    if (!header.sessionId) {
      throw new Error('Identify action missing sessionId');
    }
    hookContext.sessionId = header.sessionId;

    let actualHeader = await this._runHooks('pre', header, hookContext);
    actualHeader = await this._runHooks('wsMessage', actualHeader, hookContext);
    actualHeader = await this._runHooks('identify', actualHeader, hookContext);
    await this._runHooks('post', actualHeader, hookContext);

    const [channel] = await getChannel();
    await channel.assertQueue(hookContext.sessionId, { expires: this._queueTimeout });
    const consume = await channel.consume(
      hookContext.sessionId,
      (rmqMessage: amqplib.ConsumeMessage | null) => {
        this._handleRmqMessage(ws, rmqMessage, getChannel, hookContext);
      },
    )
    this._consumerTags.set(ws, consume.consumerTag);
  }

  private async _handlePublish(
    header: MessageHeader,
    hookContext: any,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
    payload?: ArrayBuffer,
  ) {
    if (!header.routingKey) {
      throw new Error('Publish action missing routingKey')
    }

    let actualHeader = await this._runHooks('pre', header, hookContext);
    actualHeader = await this._runHooks('wsMessage', actualHeader, hookContext);
    actualHeader = await this._runHooks('publish', actualHeader, hookContext);
    actualHeader = await this._runHooks('post', actualHeader, hookContext);

    const [channel] = await getChannel();
    channel.publish(
      this._exchangeName,
      actualHeader.routingKey!,
      // Convert ArrayBuffer payload to Buffer for RabbitMQ
      payload ? Buffer.from(payload) : Buffer.alloc(0),
      { headers: actualHeader.rmqHeaders || {} },
    );
  }

  private async _handleListen(
    header: MessageHeader,
    hookContext: any,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
  ) {
    if (!header.bindingKey) {
      throw new Error('Listen action missing bindingKey');
    }
    if (!hookContext.sessionId) {
      throw new Error('Listen action received before identify');
    }

    let actualHeader = await this._runHooks('pre', header, hookContext);
    actualHeader = await this._runHooks('wsMessage', actualHeader, hookContext);
    actualHeader = await this._runHooks('listen', actualHeader, hookContext);
    actualHeader = await this._runHooks('post', actualHeader, hookContext);

    const [channel] = await getChannel();
    await channel.bindQueue(
      hookContext.sessionId, this._exchangeName, actualHeader.bindingKey!
    );
  }

  private async _handleUnlisten(
    header: MessageHeader,
    hookContext: any,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
  ) {
    if (!header.bindingKey) {
      throw new Error('Unlisten action missing bindingKey');
    }
    if (!hookContext.sessionId) {
      throw new Error('Unlisten action received before identify');
    }

    let actualHeader = await this._runHooks('pre', header, hookContext);
    actualHeader = await this._runHooks('wsMessage', actualHeader, hookContext);
    actualHeader = await this._runHooks('unlisten', actualHeader, hookContext);
    actualHeader = await this._runHooks('post', actualHeader, hookContext);

    const [channel] = await getChannel();
    await channel.unbindQueue(hookContext.sessionId, this._exchangeName, actualHeader.bindingKey!);
  }

  private async _handleRmqMessage(
    ws: ws.WebSocket,
    rmqMessage: amqplib.ConsumeMessage | null,
    getChannel: () => Promise<[amqplib.Channel, amqplib.ChannelModel]>,
    hookContext: any,
  ) {
    this._queues.set(ws, this._queues.get(ws)!.then(async () => {
      if (!rmqMessage) {
        this._log('WARNING', 'Received null message from RabbitMQ, skipping');
        return;
      }
      let channel: amqplib.Channel;
      try {
        [channel] = await getChannel();
      } catch (err) {
        this._log('ERROR', 'Failed to get RabbitMQ channel for message processing', err as Error);
        return;
      }
      try {
        let header: MessageHeader = { action: 'message', routingKey: rmqMessage.fields.routingKey };

        header = await this._runHooks('pre', header, hookContext, rmqMessage);
        header = await this._runHooks('rmqMessage', header, hookContext, rmqMessage);
        header = await this._runHooks('post', header, hookContext, rmqMessage);

        // Pass Buffer directly, bundleData handles it
        ws.send(bundleData(header, rmqMessage.content));
        channel.ack(rmqMessage);
      } catch (err) {
        this._log('ERROR', 'Error sending message to client, requeuing', err as Error);
        try {
          channel.nack(rmqMessage, false, true);  // Requeue the message
        } catch (err) {
          this._log('ERROR', 'Failed to nack message', err as Error);
        }
      }
    }));
  }

  private _log(logLevel: LogLevel, message: string | Error, err?: Error) {
    const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL', 'SILENT']
    const instanceLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(logLevel);
    if (messageLevelIndex >= instanceLevelIndex) {
      console.log(`[${logLevel}] ${message instanceof Error ? message.stack : message}`);
    }
    if (err) {
      this._log('DEBUG', err);
    }
  }

  private _getChannelFunc(defaultConnection: amqplib.ChannelModel | null = null) {
    let connection: amqplib.ChannelModel | null = defaultConnection, channel: amqplib.Channel | null = null;
    return async (): Promise<[amqplib.Channel, amqplib.ChannelModel]> => {
      try {
        if (!connection) {
          connection = await retry(() => amqplib.connect(this._rmqUrl));
          connection.on('close', () => {
            channel = null;
            connection = null;
          })
        }
        if (!channel) {
          channel = await retry(() => connection!.createChannel());
          channel.on('close', () => { channel = null; })
        }
        this._consecutiveChannelFailures = 0;
        this._lastSuccessfulConnectionAttempt = new Date();
      } catch (err) {
        this._consecutiveChannelFailures++;
        throw err;
      }
      return [channel, connection];
    };
  }

  private async _healthCheck() {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    if (!this._lastSuccessfulConnectionAttempt || this._lastSuccessfulConnectionAttempt < oneMinuteAgo) {
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
      websockets: this._webSockets.size,
    }
  }

  private async _runHooks(hookName: HookName, header: MessageHeader, context: any, rmqMessage?: any) {
    const hooks = this._hooks[hookName];
    let actualHeader = header;
    for (const hook of hooks) {
      actualHeader = await hook(actualHeader, context, rmqMessage);
      if (actualHeader === undefined) {
        throw new Error(`Hook ${hookName} did not return a header object`);
      }
    };
    return actualHeader;
  }
}

const shutdownHandler = async (signal: string) => {
  console.log(`Received ${signal}, shutting down all WebMQ servers gracefully...`);
  await Promise.all(
    (WebMQServer as any)._instances.map((instance: WebMQServer) => instance.stop())
  );
  process.exit(0);
};
process.on('SIGTERM', shutdownHandler);
process.on('SIGINT', shutdownHandler);

/**
 * Bundles a JSON header and an optional binary payload into a single ArrayBuffer.
 * Structure: [4 bytes (Header Length)] + [Header (JSON)] + [Optional Payload]
 */
function bundleData(header: object, payload?: ArrayBuffer | Buffer): ArrayBuffer {
  // 1. Convert JSON Header to bytes
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(JSON.stringify(header));

  // 2. Calculate Total Length
  // Always include 4 bytes for the length + the header bytes.
  // Only add payload length if it exists.
  const payloadLength = payload ? payload.byteLength : 0;
  const totalByteLength = 4 + headerBytes.byteLength + payloadLength;

  // 3. Create the Master Buffer
  const masterBuffer = new ArrayBuffer(totalByteLength);
  const view = new Uint8Array(masterBuffer);
  const dataView = new DataView(masterBuffer);

  // 4. Write the Header Length (Big Endian)
  dataView.setUint32(0, headerBytes.byteLength, false);

  // 5. Write the Header Bytes
  view.set(headerBytes, 4);

  // 6. Write the Payload (only if it exists)
  if (payload) {
    const payloadOffset = 4 + headerBytes.byteLength;
    // Handle both ArrayBuffer and Buffer
    const payloadBytes = Buffer.isBuffer(payload) ? payload : new Uint8Array(payload);
    view.set(payloadBytes, payloadOffset);
  }

  return masterBuffer;
}

/**
 * Unbundles an ArrayBuffer into a JSON header and optional binary payload.
 * Structure: [4 bytes (Header Length)] + [Header (JSON)] + [Optional Payload]
 * @returns [header, payload?] - Tuple of parsed header and optional payload
 */
function unbundleData(buffer: ArrayBuffer): [any, ArrayBuffer?] {
  const dataView = new DataView(buffer);

  // 1. Read Header Length (first 4 bytes, Big Endian)
  const headerLength = dataView.getUint32(0, false);

  if (headerLength > 1024 * 1024) {
    throw new Error(`Header length ${headerLength} exceeds maximum allowed size`);
  }

  // 2. Extract and parse Header (JSON)
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const decoder = new TextDecoder();
  const headerString = decoder.decode(headerBytes);
  const header = JSON.parse(headerString);

  // 3. Extract Payload (if any exists after header)
  const payloadOffset = 4 + headerLength;
  const payload = payloadOffset < buffer.byteLength
    ? buffer.slice(payloadOffset)
    : undefined;

  return [header, payload];
}

async function retry<T>(fn: () => Promise<T>, delays = [0, 100, 200, 400]) {
  let error;
  for (let delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await fn();
    } catch (err) {
      error = err;
    }
  }
  throw error;
}
