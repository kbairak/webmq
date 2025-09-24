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
    server.logLevel = 'silent';
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

    it('should handle missing required fields for publish', async () => {
      const invalidMessage: ClientMessage = {
        action: 'publish',
        // Missing routingKey and payload
      } as any;

      await expect((server as any).processMessage(connectionId, invalidMessage))
        .rejects.toThrow('publish requires routingKey and payload');
    });

    it('should handle missing routingKey in publish', async () => {
      const invalidMessage: ClientMessage = {
        action: 'publish',
        payload: { data: 'test' },
        // Missing routingKey
      } as any;

      await expect((server as any).processMessage(connectionId, invalidMessage))
        .rejects.toThrow('publish requires routingKey and payload');
    });

    it('should handle missing payload in publish', async () => {
      const invalidMessage: ClientMessage = {
        action: 'publish',
        routingKey: 'test.route',
        // Missing payload
      } as any;

      await expect((server as any).processMessage(connectionId, invalidMessage))
        .rejects.toThrow('publish requires routingKey and payload');
    });

    it('should handle missing bindingKey in listen', async () => {
      const invalidMessage: ClientMessage = {
        action: 'listen',
        // Missing bindingKey
      } as any;

      await expect((server as any).processMessage(connectionId, invalidMessage))
        .rejects.toThrow('listen requires a bindingKey');
    });

    it('should handle missing bindingKey in unlisten', async () => {
      const invalidMessage: ClientMessage = {
        action: 'unlisten',
        // Missing bindingKey
      } as any;

      await expect((server as any).processMessage(connectionId, invalidMessage))
        .rejects.toThrow('unlisten requires a bindingKey');
    });

    it('should handle missing sessionId in identify', async () => {
      const invalidMessage: ClientMessage = {
        action: 'identify',
        // Missing sessionId
      } as any;

      await expect((server as any).processMessage(connectionId, invalidMessage))
        .rejects.toThrow('identify requires a sessionId');
    });

    it('should handle unknown action types', async () => {
      const invalidMessage = {
        action: 'unknown-action' as any,
      };

      await expect((server as any).processMessage(connectionId, invalidMessage))
        .rejects.toThrow('Unknown action: unknown-action');
    });

    it('should handle missing connection during message processing', async () => {
      const nonExistentConnectionId = 'non-existent-id';

      await expect((server as any).processMessage(nonExistentConnectionId, {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' },
      })).rejects.toThrow('Connection non-existent-id not found');
    });

    it('should handle already existing subscriptions in listen', async () => {
      // First subscription
      await (server as any).processMessage(connectionId, {
        action: 'listen',
        bindingKey: 'test.*',
      });

      // Second subscription to same binding key should not create another consumer
      await (server as any).processMessage(connectionId, {
        action: 'listen',
        bindingKey: 'test.*',
      });

      // Should only have called consume once
      expect(mockChannel.consume).toHaveBeenCalledTimes(1);
    });

    it('should handle non-existent subscription in unlisten', async () => {
      // Try to unlisten without having subscribed first
      await (server as any).processMessage(connectionId, {
        action: 'unlisten',
        bindingKey: 'non-existent.*',
      });

      // Should not call cancel since no subscription exists
      expect(mockChannel.cancel).not.toHaveBeenCalled();
    });

    it('should handle RabbitMQ errors during subscription', async () => {
      // Make consume fail
      mockChannel.consume.mockRejectedValueOnce(new Error('RabbitMQ subscription error'));

      await expect((server as any).processMessage(connectionId, {
        action: 'listen',
        bindingKey: 'test.*',
      })).rejects.toThrow('RabbitMQ subscription error');
    });

    it('should handle RabbitMQ errors during unsubscription', async () => {
      // First create a subscription
      await (server as any).processMessage(connectionId, {
        action: 'listen',
        bindingKey: 'test.*',
      });

      // Make cancel fail
      mockChannel.cancel.mockRejectedValueOnce(new Error('RabbitMQ unsubscription error'));

      await expect((server as any).processMessage(connectionId, {
        action: 'unlisten',
        bindingKey: 'test.*',
      })).rejects.toThrow('RabbitMQ unsubscription error');
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
      const preHook = jest.fn(async (context, message, next) => await next());
      const publishHook = jest.fn(async (context, message, next) => await next());

      const serverWithHooks = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
        hooks: {
          pre: [preHook],
          onPublish: [publishHook],
        }
      });
      serverWithHooks.logLevel = 'silent';

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

    it('should execute hooks in correct order for all action types', async () => {
      const executionOrder: string[] = [];
      const preHook = jest.fn(async (context, message, next) => {
        executionOrder.push('pre');
        await next();
      });
      const publishHook = jest.fn(async (context, message, next) => {
        executionOrder.push('onPublish');
        await next();
      });
      const listenHook = jest.fn(async (context, message, next) => {
        executionOrder.push('onListen');
        await next();
      });
      const unlistenHook = jest.fn(async (context, message, next) => {
        executionOrder.push('onUnlisten');
        await next();
      });

      const serverWithHooks = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
        hooks: {
          pre: [preHook],
          onPublish: [publishHook],
          onListen: [listenHook],
          onUnlisten: [unlistenHook],
        }
      });
      serverWithHooks.logLevel = 'silent';

      await serverWithHooks.start(8086);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (serverWithHooks as any).handleConnection(mockWS);
      const connections = (serverWithHooks as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      // Test publish hooks
      executionOrder.length = 0;
      await (serverWithHooks as any).processMessage(connectionId, {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' },
      });
      expect(executionOrder).toEqual(['pre', 'onPublish']);

      // Test listen hooks
      executionOrder.length = 0;
      await (serverWithHooks as any).processMessage(connectionId, {
        action: 'listen',
        bindingKey: 'test.*',
      });
      expect(executionOrder).toEqual(['pre', 'onListen']);

      // Test unlisten hooks
      executionOrder.length = 0;
      await (serverWithHooks as any).processMessage(connectionId, {
        action: 'unlisten',
        bindingKey: 'test.*',
      });
      expect(executionOrder).toEqual(['pre', 'onUnlisten']);

      await serverWithHooks.stop();
    });

    it('should allow hooks to modify context and message', async () => {
      const contextModifyingHook = jest.fn(async (context, message, next) => {
        context.userId = 'test-user';
        message.routingKey = 'modified.' + message.routingKey;
        await next();
      });

      const serverWithHooks = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
        hooks: {
          pre: [contextModifyingHook],
        }
      });
      serverWithHooks.logLevel = 'silent';

      await serverWithHooks.start(8087);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (serverWithHooks as any).handleConnection(mockWS);
      const connections = (serverWithHooks as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      await (serverWithHooks as any).processMessage(connectionId, {
        action: 'publish',
        routingKey: 'original.route',
        payload: { data: 'test' },
      });

      expect(contextModifyingHook).toHaveBeenCalled();
      const [context, message] = contextModifyingHook.mock.calls[0];
      expect(context.userId).toBe('test-user');
      expect(message.routingKey).toBe('modified.original.route');

      // Verify the modified routing key was used for publishing
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'modified.original.route',
        Buffer.from(JSON.stringify({ data: 'test' }))
      );

      await serverWithHooks.stop();
    });

    it('should handle hook errors gracefully', async () => {
      const failingHook = jest.fn(async (context, message, next) => {
        throw new Error('Hook failed');
      });

      const serverWithHooks = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
        hooks: {
          pre: [failingHook],
        }
      });
      serverWithHooks.logLevel = 'silent';

      await serverWithHooks.start(8088);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (serverWithHooks as any).handleConnection(mockWS);
      const connections = (serverWithHooks as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      await expect((serverWithHooks as any).processMessage(connectionId, {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' },
      })).rejects.toThrow('Hook failed');

      await serverWithHooks.stop();
    });
  });

  describe('Message Processing Flow', () => {
    it('should process publish message and send acknowledgment', async () => {
      const server = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
      });
      server.logLevel = 'silent';

      await server.start(8089);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);
      const connections = (server as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      const publishMessage = {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' },
        messageId: 'msg-123',
      };

      await (server as any).processMessage(connectionId, publishMessage);

      expect(mockWS.send).toHaveBeenCalledWith(
        JSON.stringify({
          action: 'ack',
          messageId: 'msg-123',
          status: 'success',
        })
      );

      await server.stop();
    });

    it('should process listen message and create queue subscription', async () => {
      const server = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
      });
      server.logLevel = 'silent';

      await server.start(8090);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);
      const connections = (server as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      const listenMessage = {
        action: 'listen',
        bindingKey: 'test.*',
      };

      await (server as any).processMessage(connectionId, listenMessage);

      // Listen messages don't send acknowledgments as they don't have messageId

      // Should create subscription in connection state
      const connection = connections.get(connectionId);
      expect(connection.subscriptions.has('test.*')).toBe(true);

      await server.stop();
    });

    it('should process unlisten message and remove subscription', async () => {
      const server = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
      });
      server.logLevel = 'silent';

      await server.start(8091);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);
      const connections = (server as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      // First create a subscription
      await (server as any).processMessage(connectionId, {
        action: 'listen',
        bindingKey: 'test.*',
      });

      // Verify subscription exists
      const connection = connections.get(connectionId);
      expect(connection.subscriptions.has('test.*')).toBe(true);

      // Now unlisten
      const unlistenMessage = {
        action: 'unlisten',
        bindingKey: 'test.*',
      };

      await (server as any).processMessage(connectionId, unlistenMessage);

      // Unlisten messages don't send acknowledgments as they don't have messageId

      // Should remove subscription
      expect(connection.subscriptions.has('test.*')).toBe(false);

      await server.stop();
    });

    it('should handle incoming RabbitMQ messages and forward to clients', async () => {
      const server = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
      });
      server.logLevel = 'silent';

      await server.start(8092);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);
      const connections = (server as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      // Create subscription
      await (server as any).processMessage(connectionId, {
        action: 'listen',
        bindingKey: 'test.*',
      });

      const connection = connections.get(connectionId);
      const subscription = connection.subscriptions.get('test.*');
      expect(subscription).toBeDefined();
      expect(subscription.queue).toBeDefined();
      expect(subscription.consumerTag).toBeDefined();

      // Since we can't easily test the callback without real RabbitMQ,
      // we'll just verify the subscription structure is correct

      // Note: The actual message forwarding is tested in e2e tests
      // as it requires real RabbitMQ message consumption

      await server.stop();
    });

    it('should handle WebSocket disconnection and cleanup subscriptions', async () => {
      const server = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
      });
      server.logLevel = 'silent';

      await server.start(8093);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);
      const connections = (server as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      // Create subscription
      await (server as any).processMessage(connectionId, {
        action: 'listen',
        bindingKey: 'test.*',
      });

      // Verify connection and subscription exist
      expect(connections.has(connectionId)).toBe(true);
      expect(connections.get(connectionId).subscriptions.has('test.*')).toBe(true);

      // Simulate WebSocket close event
      const closeHandler = mockWS.on.mock.calls.find(call => call[0] === 'close')[1];
      await closeHandler();

      // Should cleanup connection and subscriptions
      expect(connections.has(connectionId)).toBe(false);

      await server.stop();
    });

    it('should handle JSON parsing errors gracefully', async () => {
      const server = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
      });
      server.logLevel = 'silent';

      await server.start(8094);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);

      // Simulate message event with invalid JSON
      const messageHandler = mockWS.on.mock.calls.find(call => call[0] === 'message')[1];
      messageHandler('invalid json string');

      // Should send error message
      expect(mockWS.send).toHaveBeenCalledWith(
        expect.stringContaining('"action":"error"')
      );

      await server.stop();
    });

    it('should handle message acknowledgments properly', async () => {
      const server = new WebMQServer({
        rabbitmqUrl: 'amqp://localhost',
        exchangeName: 'test-exchange',
      });
      server.logLevel = 'silent';

      await server.start(8095);

      const mockWS = {
        send: jest.fn(),
        on: jest.fn(),
        readyState: WebSocket.OPEN,
      };

      (server as any).handleConnection(mockWS);
      const connections = (server as any).connections;
      const connectionId = Array.from(connections.keys())[0] as string;

      // Test message with messageId
      await (server as any).processMessage(connectionId, {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' },
        messageId: 'unique-id',
      });

      expect(mockWS.send).toHaveBeenCalledWith(
        JSON.stringify({
          action: 'ack',
          messageId: 'unique-id',
          status: 'success',
        })
      );

      // Test message without messageId (should not send ack)
      mockWS.send.mockClear();
      await (server as any).processMessage(connectionId, {
        action: 'publish',
        routingKey: 'test.route2',
        payload: { data: 'test2' },
      });

      expect(mockWS.send).not.toHaveBeenCalled();

      await server.stop();
    });
  });
});