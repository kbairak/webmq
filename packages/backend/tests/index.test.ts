import WebMQServer, { MessageHeader, HookContext } from '../src';
import { bundleData, unbundleData } from '../src/utils';
import * as amqplib from 'amqplib';
import * as ws from 'ws';
import * as http from 'http';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockChannel() {
  const consumers = new Map<
    string,
    (msg: amqplib.ConsumeMessage | null) => void
  >();
  const queues = new Map<string, any>();
  const bindings = new Map<string, Set<string>>();

  return {
    ack: jest.fn(),
    nack: jest.fn(),
    assertExchange: jest.fn(() => Promise.resolve({ exchange: 'test' })),
    assertQueue: jest.fn((name: string, options: any) => {
      queues.set(name, options);
      return Promise.resolve({ queue: name });
    }),
    bindQueue: jest.fn(
      (queue: string, _exchange: string, bindingKey: string) => {
        if (!bindings.has(queue)) bindings.set(queue, new Set());
        bindings.get(queue)!.add(bindingKey);
        return Promise.resolve();
      }
    ),
    unbindQueue: jest.fn(
      (queue: string, _exchange: string, bindingKey: string) => {
        bindings.get(queue)?.delete(bindingKey);
        return Promise.resolve();
      }
    ),
    consume: jest.fn((queue: string, callback: any) => {
      consumers.set(queue, callback);
      return Promise.resolve({
        consumerTag: `consumer-${queue}-${Date.now()}`,
      });
    }),
    publish: jest.fn(() => true),
    cancel: jest.fn(() => Promise.resolve()),
    deleteQueue: jest.fn(() => Promise.resolve()),
    close: jest.fn(() => Promise.resolve()),
    on: jest.fn(),

    _simulateMessage: (queue: string, message: amqplib.ConsumeMessage) => {
      const consumer = consumers.get(queue);
      if (consumer) consumer(message);
    },
    _getBindings: (queue: string) => bindings.get(queue),
    _getQueues: () => queues,
  };
}

function createMockConnection(mockChannel: any) {
  return {
    close: jest.fn(() => Promise.resolve()),
    createChannel: jest.fn(() => Promise.resolve(mockChannel)),
    on: jest.fn(),
  };
}

function createMockWebSocket() {
  const listeners = new Map<string, Set<Function>>();

  const mock: any = {
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    removeAllListeners: jest.fn((event?: string) => {
      if (event) listeners.delete(event);
      else listeners.clear();
    }),
    readyState: 1, // OPEN
    binaryType: 'arraybuffer',
    OPEN: 1,
    _triggerEvent: (event: string, ...args: any[]) => {
      listeners.get(event)?.forEach((handler) => handler(...args));
    },
    _receiveMessage: (header: MessageHeader, payload?: ArrayBuffer) => {
      const data = bundleData(header, payload);
      mock._triggerEvent('message', data);
    },
  };

  return mock;
}

function createMockWebSocketServer() {
  const listeners = new Map<string, Set<Function>>();

  return {
    on: jest.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    close: jest.fn(),
    _simulateConnection: (mockWs: any) => {
      listeners.get('connection')?.forEach((handler) => handler(mockWs));
    },
  };
}

function createMockHttpServer() {
  let requestHandler: any = null;

  return {
    listen: jest.fn(),
    _setRequestHandler: (handler: any) => {
      requestHandler = handler;
    },
    _simulateRequest: async (url: string) => {
      const req = { url } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
      } as unknown as http.ServerResponse;

      if (requestHandler) await requestHandler(req, res);
      return res;
    },
  };
}

function createRabbitMQMessage(
  routingKey: string,
  content: Buffer | ArrayBuffer = Buffer.alloc(0)
): amqplib.ConsumeMessage {
  return {
    content: Buffer.isBuffer(content) ? content : Buffer.from(content),
    fields: {
      deliveryTag: Math.random(),
      redelivered: false,
      exchange: 'test-exchange',
      routingKey,
      consumerTag: 'test-consumer',
    },
    properties: {
      contentType: undefined,
      contentEncoding: undefined,
      headers: {},
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  };
}

// ============================================================================
// Mock Setup
// ============================================================================

jest.mock('amqplib', () => ({
  connect: jest.fn(),
}));

jest.mock('ws', () => {
  const actual = jest.requireActual('ws');
  return {
    ...actual,
    WebSocketServer: jest.fn(),
  };
});

jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return {
    ...actual,
    createServer: jest.fn(),
  };
});

// Test helper to wait for queue processing
const waitForQueue = () => new Promise((resolve) => setTimeout(resolve, 20));

// Suppress console output during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ============================================================================
// Test Suites
// ============================================================================

describe('WebMQServer', () => {
  let mockChannel: any;
  let mockConnection: any;
  let mockWsServer: any;
  let mockHttpServer: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockChannel = createMockChannel();
    mockConnection = createMockConnection(mockChannel);
    mockWsServer = createMockWebSocketServer();
    mockHttpServer = createMockHttpServer();

    (amqplib.connect as jest.Mock).mockResolvedValue(mockConnection);
    (ws.WebSocketServer as unknown as jest.Mock).mockReturnValue(mockWsServer);
    (http.createServer as jest.Mock).mockImplementation((handler) => {
      mockHttpServer._setRequestHandler(handler);
      return mockHttpServer;
    });
  });

  describe('Initialization', () => {
    it('should initialize with provided options', () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
        healthEndpoint: '/custom-health',
        metricsEndpoint: '/custom-metrics',
        queueTimeout: 10000,
        logLevel: 'ERROR',
      });

      expect(server).toBeInstanceOf(WebMQServer);
      expect(server.logLevel).toBe('ERROR');
    });

    it('should use default values for optional parameters', () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      expect(server.logLevel).toBe('INFO');
    });
  });

  describe('Server Lifecycle', () => {
    it('should start and connect to RabbitMQ', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      await server.start();

      expect(amqplib.connect).toHaveBeenCalledWith('amqp://localhost');
      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'test-exchange',
        'topic',
        { durable: true }
      );
      expect(ws.WebSocketServer).toHaveBeenCalled();
    });

    it('should create HTTP server when health or metrics endpoints are enabled', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
        healthEndpoint: '/health',
      });

      await server.start();

      expect(http.createServer).toHaveBeenCalled();
      expect(mockHttpServer.listen).toHaveBeenCalledWith(8080);
    });

    it('should stop gracefully and cleanup resources', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      await server.start();

      const mockWs = createMockWebSocket();
      mockWsServer._simulateConnection(mockWs);

      await server.stop();

      expect(mockWs.removeAllListeners).toHaveBeenCalledWith('message');
      expect(mockWs.close).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });
  });

  describe('WebSocket Message Handling', () => {
    let server: WebMQServer;
    let mockWs: any;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      await server.start();
      mockWs = createMockWebSocket();
      mockWsServer._simulateConnection(mockWs);
    });

    describe('Identify Action', () => {
      it('should create queue and start consuming on identify', async () => {
        mockWs._receiveMessage({
          action: 'identify',
          sessionId: 'session-123',
          messageId: 'msg-1',
        });

        // Wait for queued operations to complete
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockChannel.assertQueue).toHaveBeenCalledWith(
          'session-123',
          expect.objectContaining({ expires: expect.any(Number) })
        );
        expect(mockChannel.consume).toHaveBeenCalledWith(
          'session-123',
          expect.any(Function)
        );
        expect(mockWs.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));

        const [ackData] = mockWs.send.mock.calls[0];
        const [ackHeader] = unbundleData(ackData);
        expect(ackHeader.action).toBe('ack');
        expect(ackHeader.messageId).toBe('msg-1');
      });

      it('should reject identify without sessionId', async () => {
        mockWs._receiveMessage({
          action: 'identify',
          messageId: 'msg-1',
        });

        await waitForQueue();

        const [nackData] = mockWs.send.mock.calls[0];
        const [nackHeader] = unbundleData(nackData);
        expect(nackHeader.action).toBe('nack');
        expect(nackHeader.error).toContain('sessionId');
      });
    });

    describe('Publish Action', () => {
      it('should publish message to RabbitMQ', async () => {
        const payload = new ArrayBuffer(16);
        const view = new Uint8Array(payload);
        view.set([1, 2, 3, 4]);

        mockWs._receiveMessage(
          {
            action: 'publish',
            routingKey: 'test.route',
            messageId: 'msg-1',
          },
          payload
        );

        await waitForQueue();

        expect(mockChannel.publish).toHaveBeenCalledWith(
          'test-exchange',
          'test.route',
          expect.any(Buffer),
          undefined
        );

        const publishedBuffer = mockChannel.publish.mock.calls[0][2] as Buffer;
        expect(publishedBuffer.byteLength).toBe(16);
        expect(Array.from(publishedBuffer.slice(0, 4))).toEqual([1, 2, 3, 4]);
      });

      it('should publish with RabbitMQ options', async () => {
        mockWs._receiveMessage({
          action: 'publish',
          routingKey: 'test.route',
          messageId: 'msg-1',
          rmqOptions: { persistent: true, priority: 5 },
        });

        await waitForQueue();

        expect(mockChannel.publish).toHaveBeenCalledWith(
          'test-exchange',
          'test.route',
          expect.any(Buffer),
          { persistent: true, priority: 5 }
        );
      });

      it('should reject publish without routingKey', async () => {
        mockWs._receiveMessage({
          action: 'publish',
          messageId: 'msg-1',
        });

        await waitForQueue();

        const [nackData] = mockWs.send.mock.calls[0];
        const [nackHeader] = unbundleData(nackData);
        expect(nackHeader.action).toBe('nack');
        expect(nackHeader.error).toContain('routingKey');
      });
    });

    describe('Listen Action', () => {
      beforeEach(async () => {
        mockWs._receiveMessage({
          action: 'identify',
          sessionId: 'session-123',
          messageId: 'msg-0',
        });
        await waitForQueue();
        jest.clearAllMocks();
      });

      it('should bind queue to exchange with binding key', async () => {
        mockWs._receiveMessage({
          action: 'listen',
          bindingKey: 'events.#',
          messageId: 'msg-1',
        });

        await waitForQueue();

        expect(mockChannel.bindQueue).toHaveBeenCalledWith(
          'session-123',
          'test-exchange',
          'events.#'
        );

        const bindings = mockChannel._getBindings('session-123');
        expect(bindings?.has('events.#')).toBe(true);
      });

      it('should reject listen without bindingKey', async () => {
        mockWs._receiveMessage({
          action: 'listen',
          messageId: 'msg-1',
        });

        await waitForQueue();

        const [nackData] = mockWs.send.mock.calls[0];
        const [nackHeader] = unbundleData(nackData);
        expect(nackHeader.action).toBe('nack');
        expect(nackHeader.error).toContain('bindingKey');
      });

      it('should reject listen before identify', async () => {
        const newWs = createMockWebSocket();
        mockWsServer._simulateConnection(newWs);

        newWs._receiveMessage({
          action: 'listen',
          bindingKey: 'events.#',
          messageId: 'msg-1',
        });

        await waitForQueue();

        const [nackData] = newWs.send.mock.calls[0];
        const [nackHeader] = unbundleData(nackData);
        expect(nackHeader.action).toBe('nack');
        expect(nackHeader.error).toContain('before identify');
      });
    });

    describe('Unlisten Action', () => {
      beforeEach(async () => {
        mockWs._receiveMessage({
          action: 'identify',
          sessionId: 'session-123',
          messageId: 'msg-0',
        });
        await waitForQueue();

        mockWs._receiveMessage({
          action: 'listen',
          bindingKey: 'events.#',
          messageId: 'msg-1',
        });
        await waitForQueue();

        jest.clearAllMocks();
      });

      it('should unbind queue from exchange', async () => {
        mockWs._receiveMessage({
          action: 'unlisten',
          bindingKey: 'events.#',
          messageId: 'msg-2',
        });

        await waitForQueue();

        expect(mockChannel.unbindQueue).toHaveBeenCalledWith(
          'session-123',
          'test-exchange',
          'events.#'
        );

        const bindings = mockChannel._getBindings('session-123');
        expect(bindings?.has('events.#')).toBe(false);
      });

      it('should reject unlisten without bindingKey', async () => {
        mockWs._receiveMessage({
          action: 'unlisten',
          messageId: 'msg-2',
        });

        await waitForQueue();

        const [nackData] = mockWs.send.mock.calls[0];
        const [nackHeader] = unbundleData(nackData);
        expect(nackHeader.action).toBe('nack');
        expect(nackHeader.error).toContain('bindingKey');
      });
    });

    describe('Invalid Messages', () => {
      it('should ignore non-binary messages', async () => {
        mockWs._triggerEvent('message', 'invalid string');
        await waitForQueue();
        expect(mockWs.send).not.toHaveBeenCalled();
      });

      it('should ignore messages without messageId', async () => {
        mockWs._receiveMessage({ action: 'publish' } as MessageHeader);
        await waitForQueue();
        expect(mockChannel.publish).not.toHaveBeenCalled();
      });

      it('should reject unknown actions', async () => {
        mockWs._receiveMessage({
          action: 'unknown' as any,
          messageId: 'msg-1',
        });

        await waitForQueue();

        const [nackData] = mockWs.send.mock.calls[0];
        const [nackHeader] = unbundleData(nackData);
        expect(nackHeader.action).toBe('nack');
        expect(nackHeader.error).toContain('Unknown action');
      });
    });
  });

  describe('RabbitMQ to WebSocket Flow', () => {
    let server: WebMQServer;
    let mockWs: any;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      await server.start();
      mockWs = createMockWebSocket();
      mockWsServer._simulateConnection(mockWs);

      mockWs._receiveMessage({
        action: 'identify',
        sessionId: 'session-123',
        messageId: 'msg-0',
      });
      await waitForQueue();

      jest.clearAllMocks();
    });

    it('should forward RabbitMQ messages to WebSocket', async () => {
      const payload = Buffer.from('Hello, WebSocket!');
      const rmqMessage = createRabbitMQMessage('test.route', payload);

      mockChannel._simulateMessage('session-123', rmqMessage);
      await waitForQueue();

      expect(mockWs.send).toHaveBeenCalled();

      const [sentData] = mockWs.send.mock.calls[0];
      const [header, receivedPayload] = unbundleData(sentData);

      expect(header.action).toBe('message');
      expect(header.routingKey).toBe('test.route');
      expect(Buffer.from(receivedPayload!)).toEqual(payload);
      expect(mockChannel.ack).toHaveBeenCalledWith(rmqMessage);
    });

    it('should nack and requeue on WebSocket send failure', async () => {
      mockWs.readyState = 0; // CONNECTING
      const rmqMessage = createRabbitMQMessage('test.route');

      mockChannel._simulateMessage('session-123', rmqMessage);
      await waitForQueue();

      expect(mockChannel.nack).toHaveBeenCalledWith(rmqMessage, false, true);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should handle null RabbitMQ messages gracefully', async () => {
      const consumers = mockChannel.consume.mock.calls[0];
      const callback = consumers?.[1];

      if (callback) callback(null);
      await waitForQueue();

      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });
  });

  describe('Hook System', () => {
    let server: WebMQServer;
    let mockWs: any;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      await server.start();
      mockWs = createMockWebSocket();
      mockWsServer._simulateConnection(mockWs);
    });

    it('should execute hooks in correct order', async () => {
      const executionOrder: string[] = [];

      server.addHook('pre', async (header, context) => {
        executionOrder.push('pre');
        return header;
      });

      server.addHook('wsMessage', async (header, context) => {
        executionOrder.push('wsMessage');
        return header;
      });

      server.addHook('identify', async (header, context) => {
        executionOrder.push('identify');
        return header;
      });

      server.addHook('post', async (header, context) => {
        executionOrder.push('post');
        return header;
      });

      mockWs._receiveMessage({
        action: 'identify',
        sessionId: 'session-123',
        messageId: 'msg-1',
      });

      await waitForQueue();

      expect(executionOrder).toEqual(['pre', 'wsMessage', 'identify', 'post']);
    });

    it('should allow hooks to modify headers', async () => {
      server.addHook('publish', async (header, context) => {
        return { ...header, routingKey: 'modified.route' };
      });

      mockWs._receiveMessage({
        action: 'publish',
        routingKey: 'original.route',
        messageId: 'msg-1',
      });

      await waitForQueue();

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'modified.route',
        expect.any(Buffer),
        undefined
      );
    });

    it('should add context to hooks', async () => {
      let capturedContext: HookContext | null = null;

      server.addHook('identify', async (header, context) => {
        capturedContext = context;
        return header;
      });

      mockWs._receiveMessage({
        action: 'identify',
        sessionId: 'session-123',
        messageId: 'msg-1',
      });

      await waitForQueue();

      expect(capturedContext).toBeTruthy();
      expect((capturedContext as any).ws).toBe(mockWs);
      expect((capturedContext as any).sessionId).toBe('session-123');
    });

    it('should allow removing hooks', async () => {
      const hookFn = jest.fn(async (header) => header);

      server.addHook('publish', hookFn);
      server.removeHook('publish', hookFn);

      mockWs._receiveMessage({
        action: 'publish',
        routingKey: 'test.route',
        messageId: 'msg-1',
      });

      await waitForQueue();

      expect(hookFn).not.toHaveBeenCalled();
    });

    it('should handle hook errors and send nack', async () => {
      server.addHook('publish', async () => {
        throw new Error('Hook processing failed');
      });

      mockWs._receiveMessage({
        action: 'publish',
        routingKey: 'test.route',
        messageId: 'msg-1',
      });

      await waitForQueue();

      const [nackData] = mockWs.send.mock.calls[0];
      const [nackHeader] = unbundleData(nackData);
      expect(nackHeader.action).toBe('nack');
      expect(nackHeader.error).toContain('Hook processing failed');
    });
  });

  describe('WebSocket Lifecycle', () => {
    let server: WebMQServer;
    let mockWs: any;
    let consumerTag: string;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      await server.start();
      mockWs = createMockWebSocket();
      mockWsServer._simulateConnection(mockWs);

      mockWs._receiveMessage({
        action: 'identify',
        sessionId: 'session-123',
        messageId: 'msg-0',
      });
      await waitForQueue();

      // Capture consumer tag before clearing mocks
      consumerTag = (await mockChannel.consume.mock.results[0].value)
        .consumerTag;

      jest.clearAllMocks();
    });

    it('should cleanup on normal WebSocket close', async () => {
      mockWs._triggerEvent('close', 1000); // Normal closure
      await waitForQueue();

      expect(mockChannel.cancel).toHaveBeenCalledWith(consumerTag);
      expect(mockChannel.deleteQueue).toHaveBeenCalledWith('session-123');
    });

    it('should cleanup on abnormal WebSocket close without deleting queue', async () => {
      mockWs._triggerEvent('close', 1006); // Abnormal closure
      await waitForQueue();

      expect(mockChannel.cancel).toHaveBeenCalledWith(consumerTag);
      expect(mockChannel.deleteQueue).not.toHaveBeenCalled();
    });
  });

  describe('Message Queue Serialization', () => {
    let server: WebMQServer;
    let mockWs: any;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      await server.start();
      mockWs = createMockWebSocket();
      mockWsServer._simulateConnection(mockWs);
    });

    it('should process messages serially per WebSocket', async () => {
      const processingOrder: string[] = [];

      server.addHook('publish', async (header) => {
        processingOrder.push(`start-${header.messageId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        processingOrder.push(`end-${header.messageId}`);
        return header;
      });

      mockWs._receiveMessage({
        action: 'publish',
        routingKey: 'test.1',
        messageId: 'msg-1',
      });

      mockWs._receiveMessage({
        action: 'publish',
        routingKey: 'test.2',
        messageId: 'msg-2',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(processingOrder).toEqual([
        'start-msg-1',
        'end-msg-1',
        'start-msg-2',
        'end-msg-2',
      ]);
    });
  });

  describe('Health Check', () => {
    it('should respond with health status', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
        healthEndpoint: '/health',
      });

      await server.start();

      const res = await mockHttpServer._simulateRequest('/health');

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      expect(res.end).toHaveBeenCalled();

      const response = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
      expect(response).toMatchObject({
        healthy: true,
        rabbitMQQueues: 0,
        websockets: 0,
      });
    });

    it('should respond to metrics endpoint', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
        metricsEndpoint: '/metrics',
      });

      await server.start();

      const res = await mockHttpServer._simulateRequest('/metrics');

      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': expect.stringContaining('text/plain'),
        })
      );
      expect(res.end).toHaveBeenCalled();
    });

    it('should return 404 for unknown endpoints', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
        healthEndpoint: '/health',
      });

      await server.start();

      const res = await mockHttpServer._simulateRequest('/unknown');

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        'Content-Type': 'text/plain',
      });
    });
  });

  describe('Error Recovery', () => {
    it('should handle RabbitMQ connection failures gracefully', async () => {
      (amqplib.connect as jest.Mock).mockRejectedValue(
        new Error('Connection failed')
      );

      const server = new WebMQServer({
        rmqUrl: 'amqp://bad-host',
        exchange: 'test-exchange',
        port: 8080,
      });

      await expect(server.start()).rejects.toThrow('Connection failed');
    });

    it('should handle channel creation failures', async () => {
      const failingConnection = createMockConnection(mockChannel);
      failingConnection.createChannel.mockRejectedValue(
        new Error('Channel failed')
      );

      (amqplib.connect as jest.Mock).mockResolvedValue(failingConnection);

      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
      });

      await expect(server.start()).rejects.toThrow('Channel failed');
    });
  });

  describe('Logging', () => {
    it('should respect log level settings', async () => {
      const consoleSpy = jest.spyOn(console, 'log');

      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
        logLevel: 'ERROR',
      });

      await server.start();

      // Start message is INFO level, should not log when level is ERROR
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[INFO]')
      );
    });

    it('should log errors when log level permits', async () => {
      const consoleSpy = jest.spyOn(console, 'log');

      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 8080,
        logLevel: 'ERROR',
      });

      await server.start();

      const mockWs = createMockWebSocket();
      mockWsServer._simulateConnection(mockWs);

      mockWs._receiveMessage({
        action: 'unknown' as any,
        messageId: 'msg-1',
      });

      await waitForQueue();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ERROR]')
      );
    });
  });
});
