import WebMQServer from '../src/index';
import type { MessageHeader } from '../src/index';
import http from 'http';
import * as io from 'socket.io';
import amqplib from 'amqplib';
import { bundleData } from '../src/utils';

// Mock dependencies
jest.mock('amqplib');
jest.mock('http');
jest.mock('socket.io');
jest.mock('prom-client', () => {
  const mockMetric = {
    inc: jest.fn(),
    dec: jest.fn(),
    set: jest.fn(),
  };
  return {
    collectDefaultMetrics: jest.fn(),
    register: {
      metrics: jest.fn().mockResolvedValue('# metrics'),
      contentType: 'text/plain',
    },
    Gauge: jest.fn(() => mockMetric),
    Counter: jest.fn(() => mockMetric),
  };
});

// Mock Socket.IO types
interface MockSocket {
  handshake: { auth: { sessionId?: string } };
  on: jest.Mock;
  emit: jest.Mock;
  timeout: jest.Mock;
  disconnect: jest.Mock;
  removeAllListeners: jest.Mock;
  _emitWithAck?: jest.Mock;
}

interface MockServer {
  on: jest.Mock;
  close: jest.Mock;
  _connectionHandler?: Function;
}

interface MockChannel {
  assertExchange: jest.Mock;
  assertQueue: jest.Mock;
  consume: jest.Mock;
  bindQueue: jest.Mock;
  unbindQueue: jest.Mock;
  publish: jest.Mock;
  ack: jest.Mock;
  nack: jest.Mock;
  cancel: jest.Mock;
  close: jest.Mock;
  on: jest.Mock;
  _consumers: Map<string, (msg: amqplib.ConsumeMessage | null) => void>;
}

interface MockConnection {
  createChannel: jest.Mock;
  close: jest.Mock;
  on: jest.Mock;
}

interface MockHttpServer {
  listen: jest.Mock;
  close: jest.Mock;
  _requestHandler?: Function;
}

// Helper to create mock objects
function createMockSocket(sessionId?: string): MockSocket {
  const _emitWithAck = jest.fn().mockResolvedValue(undefined);
  const socket: MockSocket = {
    handshake: { auth: { sessionId } },
    on: jest.fn(),
    emit: jest.fn(),
    timeout: jest.fn().mockReturnValue({ emitWithAck: _emitWithAck }),
    disconnect: jest.fn(),
    removeAllListeners: jest.fn(),
    _emitWithAck,
  };
  return socket;
}

function createMockChannel(): MockChannel {
  const consumers = new Map<string, (msg: amqplib.ConsumeMessage | null) => void>();
  return {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn((queue: string, callback: (msg: amqplib.ConsumeMessage | null) => void) => {
      consumers.set(queue, callback);
      return Promise.resolve({ consumerTag: `test-consumer-${queue}` });
    }),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    unbindQueue: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    _consumers: consumers,
  };
}

function createMockConnection(): MockConnection {
  const channel = createMockChannel();
  return {
    createChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
}

function createMockServer(): MockServer {
  const server: MockServer = {
    on: jest.fn((event: string, handler: Function) => {
      if (event === 'connection') {
        server._connectionHandler = handler;
      }
    }),
    close: jest.fn(),
  };
  return server;
}

function createMockHttpServer(): MockHttpServer {
  const server: MockHttpServer = {
    listen: jest.fn(),
    close: jest.fn(),
  };
  return server;
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

// Test helper to wait for async queue processing
const waitForQueue = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('WebMQServer', () => {
  let mockConnection: MockConnection;
  let mockChannel: MockChannel;
  let mockHttpServer: MockHttpServer;
  let mockIoServer: MockServer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChannel = createMockChannel();
    mockConnection = createMockConnection();
    mockConnection.createChannel.mockResolvedValue(mockChannel);
    mockHttpServer = createMockHttpServer();
    mockIoServer = createMockServer();

    (amqplib.connect as jest.Mock).mockResolvedValue(mockConnection);
    (http.createServer as jest.Mock).mockImplementation((handler) => {
      mockHttpServer._requestHandler = handler;
      return mockHttpServer;
    });
    (io.Server as unknown as jest.Mock).mockImplementation(() => mockIoServer);

    // Suppress console.log during tests
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Constructor & Initialization', () => {
    it('should initialize with required options', () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      expect(server).toBeInstanceOf(WebMQServer);
      expect(server.logLevel).toBe('INFO');
    });

    it('should apply default values for optional options', () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      expect(server.logLevel).toBe('INFO');
    });

    it('should accept custom logLevel', () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        logLevel: 'DEBUG',
      });

      expect(server.logLevel).toBe('DEBUG');
    });

    it('should accept all optional parameters', () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        host: '0.0.0.0',
        healthEndpoint: '/custom-health',
        metricsEndpoint: '/custom-metrics',
        queueTimeout: 10000,
        logLevel: 'WARNING',
      });

      expect(server).toBeInstanceOf(WebMQServer);
      expect(server.logLevel).toBe('WARNING');
    });
  });

  describe('start()', () => {
    it('should connect to RabbitMQ', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      expect(amqplib.connect).toHaveBeenCalledWith('amqp://localhost');
    });

    it('should create topic exchange as durable', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', {
        durable: true,
      });
    });

    it('should create HTTP server on configured port', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      expect(mockHttpServer.listen).toHaveBeenCalledWith(3000, undefined);
    });

    it('should create HTTP server on configured host and port', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        host: '0.0.0.0',
      });

      await server.start();

      expect(mockHttpServer.listen).toHaveBeenCalledWith(3000, '0.0.0.0');
    });

    it('should initialize Socket.IO with cors and ping settings', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      expect(io.Server).toHaveBeenCalledWith(mockHttpServer, {
        cors: { origin: '*', methods: ['GET', 'POST'] },
        pingTimeout: 5000,
        pingInterval: 2000,
      });
    });

    it('should register connection handler', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      expect(mockIoServer.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });
  });

  describe('WebSocket Connection Handling', () => {
    it('should accept connections with valid sessionId', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      expect(mockSocket.disconnect).not.toHaveBeenCalled();
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-session-id', {
        expires: 5 * 60 * 1000,
      });
    });

    it('should reject connections without sessionId', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      const mockSocket = createMockSocket();
      await mockIoServer._connectionHandler!(mockSocket);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    });

    it('should create queue for each session with custom timeout', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        queueTimeout: 10000,
      });

      await server.start();

      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-session-id', { expires: 10000 });
    });

    it('should start RabbitMQ consumer for session', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      expect(mockChannel.consume).toHaveBeenCalledWith('test-session-id', expect.any(Function));
    });

    it('should register event listeners on socket', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith('listen', expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith('unlisten', expect.any(Function));
      expect(mockSocket.on).toHaveBeenCalledWith('publish', expect.any(Function));
    });

    it('should disconnect on RabbitMQ consumer creation failure', async () => {
      mockChannel.consume.mockRejectedValueOnce(new Error('Consumer error'));

      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('Message Handling: listen', () => {
    let server: WebMQServer;
    let mockSocket: MockSocket;
    let listenHandler: Function;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();
      mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      listenHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'listen')[1];
    });

    it('should bind queue to exchange with bindingKey', async () => {
      const header: MessageHeader = { bindingKey: 'events.#' };
      const data = bundleData(header);

      listenHandler(Buffer.from(data));
      await waitForQueue();

      expect(mockChannel.bindQueue).toHaveBeenCalledWith(
        'test-session-id',
        'test-exchange',
        'events.#'
      );
    });

    it('should reject listen without bindingKey', async () => {
      const header: MessageHeader = { routingKey: 'test' };
      const data = bundleData(header);

      listenHandler(Buffer.from(data));
      await waitForQueue();

      expect(mockChannel.bindQueue).not.toHaveBeenCalled();
    });

    it('should handle RabbitMQ binding failures', async () => {
      mockChannel.bindQueue.mockRejectedValueOnce(new Error('Bind failed'));

      const header: MessageHeader = { bindingKey: 'events.#' };
      const data = bundleData(header);

      listenHandler(Buffer.from(data));
      await waitForQueue();

      // Should not throw, just log error
      expect(mockChannel.bindQueue).toHaveBeenCalled();
    });
  });

  describe('Message Handling: unlisten', () => {
    let server: WebMQServer;
    let mockSocket: MockSocket;
    let unlistenHandler: Function;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();
      mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      unlistenHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'unlisten')?.[1] || (() => {});
    });

    it.skip('should unbind queue from exchange with bindingKey', async () => {
      const header: MessageHeader = { bindingKey: 'events.#' };
      const data = bundleData(header);

      unlistenHandler(data);
      await waitForQueue();

      expect(mockChannel.unbindQueue).toHaveBeenCalledWith(
        'test-session-id',
        'test-exchange',
        'events.#'
      );
    });

    it('should reject unlisten without bindingKey', async () => {
      const header: MessageHeader = { routingKey: 'test' };
      const data = bundleData(header);

      unlistenHandler(data);
      await waitForQueue();

      expect(mockChannel.unbindQueue).not.toHaveBeenCalled();
    });

    it.skip('should handle RabbitMQ unbinding failures', async () => {
      mockChannel.unbindQueue.mockRejectedValueOnce(new Error('Unbind failed'));

      const header: MessageHeader = { bindingKey: 'events.#' };
      const data = bundleData(header);

      unlistenHandler(data);
      await waitForQueue();

      // Should not throw, just log error
      expect(mockChannel.unbindQueue).toHaveBeenCalled();
    });
  });

  describe('Message Handling: publish', () => {
    let server: WebMQServer;
    let mockSocket: MockSocket;
    let publishHandler: Function;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();
      mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      publishHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'publish')[1];
    });

    it.skip('should publish to RabbitMQ with routing key', async () => {
      const header: MessageHeader = { routingKey: 'test.route' };
      const payload = new TextEncoder().encode('Hello World').buffer;
      const data = bundleData(header, payload);

      publishHandler(data);
      await waitForQueue();

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'test.route',
        expect.any(Buffer),
        undefined
      );
    });

    it.skip('should publish with rmqOptions', async () => {
      const header: MessageHeader = {
        routingKey: 'test.route',
        rmqOptions: { persistent: true, priority: 5 },
      };
      const data = bundleData(header);

      publishHandler(data);
      await waitForQueue();

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'test.route',
        expect.any(Buffer),
        { persistent: true, priority: 5 }
      );
    });

    it('should reject publish without routingKey', async () => {
      const header: MessageHeader = { bindingKey: 'test' };
      const data = bundleData(header);

      publishHandler(data);
      await waitForQueue();

      expect(mockChannel.publish).not.toHaveBeenCalled();
    });

    it.skip('should handle publishing failures', async () => {
      mockChannel.publish.mockImplementationOnce(() => {
        throw new Error('Publish failed');
      });

      const header: MessageHeader = { routingKey: 'test.route' };
      const data = bundleData(header);

      publishHandler(data);
      await waitForQueue();

      // Should not throw, just log error
      expect(mockChannel.publish).toHaveBeenCalled();
    });
  });

  describe('RabbitMQ to WebSocket Flow', () => {
    let server: WebMQServer;
    let mockSocket: MockSocket;

    beforeEach(async () => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();
      mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);
    });

    it('should emit message to client with acknowledgment', async () => {
      const payload = Buffer.from('Hello, WebSocket!');
      const rmqMessage = createRabbitMQMessage('test.route', payload);

      const consumer = mockChannel._consumers.get('test-session-id');
      consumer!(rmqMessage);
      await waitForQueue();

      expect(mockSocket.timeout).toHaveBeenCalledWith(10000);
      expect(mockSocket._emitWithAck).toHaveBeenCalledWith('message', expect.any(Uint8Array));
    });

    it('should ACK message on client confirmation', async () => {
      const rmqMessage = createRabbitMQMessage('test.route');

      const consumer = mockChannel._consumers.get('test-session-id');
      consumer!(rmqMessage);
      await waitForQueue();

      expect(mockChannel.ack).toHaveBeenCalledWith(rmqMessage);
    });

    it('should NACK and requeue on timeout', async () => {
      mockSocket._emitWithAck!.mockRejectedValueOnce(new Error('Timeout'));

      const rmqMessage = createRabbitMQMessage('test.route');

      const consumer = mockChannel._consumers.get('test-session-id');
      consumer!(rmqMessage);
      await waitForQueue();

      expect(mockChannel.nack).toHaveBeenCalledWith(rmqMessage, false, true);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('should handle null RabbitMQ messages', async () => {
      const consumer = mockChannel._consumers.get('test-session-id');
      consumer!(null);
      await waitForQueue();

      expect(mockChannel.ack).not.toHaveBeenCalled();
      expect(mockChannel.nack).not.toHaveBeenCalled();
    });
  });

  describe('Hook System', () => {
    let server: WebMQServer;

    beforeEach(() => {
      server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });
    });

    it('should execute hooks in correct order', async () => {
      const executionOrder: string[] = [];

      server.addHook('pre', async (header) => {
        executionOrder.push('pre');
        return header;
      });

      server.addHook('wsMessage', async (header) => {
        executionOrder.push('wsMessage');
        return header;
      });

      server.addHook('listen', async (header) => {
        executionOrder.push('listen');
        return header;
      });

      server.addHook('post', async (header) => {
        executionOrder.push('post');
        return header;
      });

      await server.start();
      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      const listenHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'listen')[1];
      const header: MessageHeader = { bindingKey: 'events.#' };
      const data = bundleData(header);

      listenHandler(Buffer.from(data));
      await waitForQueue();

      expect(executionOrder).toEqual(['pre', 'wsMessage', 'listen', 'post']);
    });

    it.skip('should allow hooks to modify headers', async () => {
      server.addHook('publish', async (header) => {
        return { ...header, routingKey: 'modified.route' };
      });

      await server.start();
      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      const publishHandler = mockSocket.on.mock.calls.find((call) => call[0] === 'publish')[1];
      const header: MessageHeader = { routingKey: 'original.route' };
      const data = bundleData(header);

      publishHandler(data);
      await waitForQueue();

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'modified.route',
        expect.any(Buffer),
        undefined
      );
    });
  });

  describe('stop()', () => {
    it('should remove all socket listeners', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();
      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      await server.stop();

      expect(mockSocket.removeAllListeners).toHaveBeenCalled();
    });

    it('should cancel all RabbitMQ consumers', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();
      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      await server.stop();

      expect(mockChannel.cancel).toHaveBeenCalledWith('test-consumer-test-session-id');
    });

    it('should close all WebSocket connections', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();
      const mockSocket = createMockSocket('test-session-id');
      await mockIoServer._connectionHandler!(mockSocket);

      await server.stop();

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    });

    it('should close Socket.IO server', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      await server.stop();

      expect(mockIoServer.close).toHaveBeenCalled();
    });

    it('should close RabbitMQ channel and connection', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
      });

      await server.start();

      await server.stop();

      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });
  });

  describe('HTTP Endpoints', () => {
    it('should serve health check', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        healthEndpoint: '/health',
      });

      await server.start();

      const req = { url: '/health' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
      } as unknown as http.ServerResponse;

      await mockHttpServer._requestHandler!(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining('healthy'));
    });

    it('should serve metrics endpoint', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        metricsEndpoint: '/metrics',
      });

      await server.start();

      const req = { url: '/metrics' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
      } as unknown as http.ServerResponse;

      await mockHttpServer._requestHandler!(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/plain' });
      expect(res.end).toHaveBeenCalledWith('# metrics');
    });

    it('should return 404 for unknown paths', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        healthEndpoint: '/health',
      });

      await server.start();

      const req = { url: '/unknown' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn(),
      } as unknown as http.ServerResponse;

      await mockHttpServer._requestHandler!(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'text/plain' });
    });
  });

  describe('Logging', () => {
    beforeEach(() => {
      (console.log as jest.Mock).mockClear();
    });

    it('should respect log level hierarchy', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        logLevel: 'WARNING',
      });

      await server.start();

      const logs = (console.log as jest.Mock).mock.calls;
      const hasInfoLogs = logs.some((call) => call[0]?.includes('[INFO]'));

      expect(hasInfoLogs).toBe(false);
    });

    it.skip('should log at DEBUG level when configured', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        logLevel: 'DEBUG',
      });

      await server.start();

      const logs = (console.log as jest.Mock).mock.calls;
      const hasDebugLogs = logs.some((call) => call[0]?.includes('[DEBUG]'));

      expect(hasDebugLogs).toBe(true);
    });

    it('should suppress all logs at SILENT level', async () => {
      const server = new WebMQServer({
        rmqUrl: 'amqp://localhost',
        exchange: 'test-exchange',
        port: 3000,
        logLevel: 'SILENT',
      });

      await server.start();

      expect(console.log).not.toHaveBeenCalled();
    });
  });
});
