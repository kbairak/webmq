import { WebMQServer } from './index';
import { ClientMessage } from './interfaces';
import WebSocket from 'ws';

// Mock amqplib at the top level
jest.mock('amqplib', () => {
  const mockChannel = {
    assertExchange: jest.fn().mockResolvedValue({}),
    assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue' }),
    bindQueue: jest.fn().mockResolvedValue({}),
    unbindQueue: jest.fn().mockResolvedValue({}),
    consume: jest.fn().mockResolvedValue({ consumerTag: 'test-consumer' }),
    cancel: jest.fn().mockResolvedValue({}),
    publish: jest.fn(),
    ack: jest.fn(),
    close: jest.fn().mockResolvedValue({}),
  };

  const mockConnection = {
    createChannel: jest.fn().mockResolvedValue(mockChannel),
    close: jest.fn().mockResolvedValue({}),
  };

  return {
    connect: jest.fn().mockResolvedValue(mockConnection),
    __mockChannel: mockChannel,
    __mockConnection: mockConnection,
  };
});

// Mock WebSocketServer to avoid actual server creation
jest.mock('ws', () => {
  const mockWebSocketServer = {
    on: jest.fn(),
    close: jest.fn(),
  };

  return {
    WebSocketServer: jest.fn(() => mockWebSocketServer),
    __esModule: true,
    default: {
      OPEN: 1,
    },
  };
});

// Simple integration tests for the refactored WebMQServer
describe('WebMQServer - Simplified Integration Tests', () => {
  let server: WebMQServer;
  let mockChannel: any;
  let mockConnection: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get the mocked instances
    const amqplib = require('amqplib');
    mockChannel = (amqplib as any).__mockChannel;
    mockConnection = (amqplib as any).__mockConnection;

    // Reset mockChannel.publish to default behavior
    mockChannel.publish.mockReset();
    mockChannel.publish.mockImplementation(() => {});

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange',
    });
    server.setLogLevel('silent');
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    jest.restoreAllMocks();
  });

  describe('Basic Server Lifecycle', () => {
    it('should start and stop server successfully', async () => {
      await server.start(8081); // Use different port to avoid conflicts
      await server.stop();

      expect(mockConnection.createChannel).toHaveBeenCalled();
      expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', { durable: true });
    });
  });

  describe('Message Processing (Integration)', () => {
    let mockWS: any;
    let connectionId: string;

    beforeEach(async () => {
      await server.start(8082);

      // Mock WebSocket
      mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      // Simulate connection by calling handleConnection and then extracting the connection ID
      (server as any).handleConnection(mockWS);

      // Get the connection ID from the connections map (should be the only one)
      const connections = (server as any).connections;
      connectionId = Array.from(connections.keys())[0] as string;
    });

    it('should handle publish action with ack', async () => {
      const publishMessage: ClientMessage = {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' },
        messageId: 'msg-123',
      };

      // Simulate message processing
      await (server as any).processMessage(connectionId, publishMessage);

      // Verify RabbitMQ publish was called
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'test.route',
        Buffer.from(JSON.stringify({ data: 'test' }))
      );

      // Verify ack was sent
      expect(mockWS.send).toHaveBeenCalledWith(
        JSON.stringify({
          action: 'ack',
          messageId: 'msg-123',
          status: 'success'
        })
      );
    });

    it('should handle listen action and create subscription', async () => {
      const listenMessage: ClientMessage = {
        action: 'listen',
        bindingKey: 'chat.*',
      };

      await (server as any).processMessage(connectionId, listenMessage);

      // Verify RabbitMQ operations
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('', {
        exclusive: true,
        autoDelete: true,
      });
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue', 'test-exchange', 'chat.*');
      expect(mockChannel.consume).toHaveBeenCalled();
    });

    it('should handle unlisten action and cleanup subscription', async () => {
      // First subscribe
      const listenMessage: ClientMessage = {
        action: 'listen',
        bindingKey: 'chat.*',
      };
      await (server as any).processMessage(connectionId, listenMessage);

      // Then unsubscribe
      const unlistenMessage: ClientMessage = {
        action: 'unlisten',
        bindingKey: 'chat.*',
      };
      await (server as any).processMessage(connectionId, unlistenMessage);

      // Verify cleanup
      expect(mockChannel.cancel).toHaveBeenCalledWith('test-consumer');
      expect(mockChannel.unbindQueue).toHaveBeenCalledWith('test-queue', 'test-exchange', 'chat.*');
    });

    it('should handle identify action', async () => {
      const identifyMessage: ClientMessage = {
        action: 'identify',
        sessionId: 'session-123',
      };

      await (server as any).processMessage(connectionId, identifyMessage);

      // Verify session was stored in context
      const connection = (server as any).connections.get(connectionId);
      expect(connection.context.sessionId).toBe('session-123');
    });
  });

  describe('Error Handling', () => {
    let mockWS: any;
    let connectionId: string;

    beforeEach(async () => {
      await server.start(8083);

      mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);
      const connections = (server as any).connections;
      connectionId = Array.from(connections.keys())[0] as string;
    });

    it('should send nack on publish failure', async () => {
      // Make publish fail
      mockChannel.publish.mockImplementation(() => {
        throw new Error('RabbitMQ error');
      });

      const publishMessage: ClientMessage = {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' },
        messageId: 'msg-123',
      };

      await expect((server as any).processMessage(connectionId, publishMessage))
        .rejects.toThrow('RabbitMQ error');

      // Verify nack was sent
      expect(mockWS.send).toHaveBeenCalledWith(
        JSON.stringify({
          action: 'nack',
          messageId: 'msg-123',
          error: 'RabbitMQ error'
        })
      );
    });

    it('should handle missing required fields', async () => {
      const invalidMessage: ClientMessage = {
        action: 'publish',
        // Missing routingKey and payload
      } as any;

      await expect((server as any).processMessage(connectionId, invalidMessage))
        .rejects.toThrow('publish requires routingKey and payload');
    });
  });

  describe('Connection Lifecycle', () => {
    it('should clean up connection on close', async () => {
      await server.start(8084);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);
      const connections = (server as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      // Verify connection exists
      expect((server as any).connections.has(connectionId)).toBe(true);

      // Simulate close
      await (server as any).handleClose(connectionId);

      // Verify connection was removed
      expect((server as any).connections.has(connectionId)).toBe(false);
    });
  });

  describe('Hook System', () => {
    it('should execute hooks before actions', async () => {
      const preHook = jest.fn((context, message, next) => next());
      const publishHook = jest.fn((context, message, next) => next());

      const serverWithHooks = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
        hooks: {
          pre: [preHook],
          onPublish: [publishHook],
        }
      });
      serverWithHooks.setLogLevel('silent');

      await serverWithHooks.start(8085);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (serverWithHooks as any).handleConnection(mockWS);
      const connections = (serverWithHooks as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      const publishMessage: ClientMessage = {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' },
      };

      await (serverWithHooks as any).processMessage(connectionId, publishMessage);

      expect(preHook).toHaveBeenCalled();
      expect(publishHook).toHaveBeenCalled();

      await serverWithHooks.stop();
    });
  });
});