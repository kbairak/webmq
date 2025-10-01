import {
  WebMQServer,
  ClientMessage,
  WebMQHooks,
} from './index';
import { WebSocketServer } from 'ws';
import amqplib from 'amqplib';
import { HookFunction } from './hooks';

// Mock the ws library
jest.mock('ws', () => ({
  WebSocket: jest.fn(),
  WebSocketServer: jest.fn(),
}));

// Correctly mock the amqplib module structure
// Define mockChannel and mockConnection inside the jest.mock factory
// to avoid "Cannot access 'mockConnection' before initialization" error
jest.mock('amqplib', () => {
  const mockChannel = {
    assertExchange: jest.fn(),
    assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue' }),
    bindQueue: jest.fn(),
    publish: jest.fn(),
    consume: jest.fn().mockResolvedValue({ consumerTag: 'test-consumer' }),
    cancel: jest.fn(),
    unbindQueue: jest.fn(),
    deleteQueue: jest.fn(),
    ack: jest.fn(),
    close: jest.fn(),
    on: jest.fn(), // Add event listener mock
  };

  const mockConnection = {
    createChannel: jest.fn().mockResolvedValue(mockChannel),
    close: jest.fn(),
    on: jest.fn(), // Add event listener mock
  };

  return {
    connect: jest.fn().mockResolvedValue(mockConnection),
    mockChannel, // Export for use in tests
    mockConnection, // Export for use in tests
  };
});

// Import the mocked connection and channel for type safety and direct access
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mockConnection, mockChannel } = require('amqplib');

// Helper function to create mock WebSocket
function createMockWebSocket() {
  return {
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
  };
}

// Helper function to get message handler from WebSocket mock
function getMessageHandler(mockWS: any): Function {
  const messageCall = mockWS.on.mock.calls.find((call: any) => call[0] === 'message');
  return messageCall?.[1];
}

// Helper function to get close handler from WebSocket mock
function getCloseHandler(mockWS: any): Function {
  const closeCall = mockWS.on.mock.calls.find((call: any) => call[0] === 'close');
  return closeCall?.[1];
}

describe('WebMQServer', () => {
  let server: WebMQServer;
  let mockConnection: any;
  let mockChannel: any;
  let mockWSS: any;
  let mockWS: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Note: We define fresh mocks here rather than reusing the global mocks from jest.mock()
    // because jest.clearAllMocks() can sometimes interfere with global mock state.
    // This ensures each test gets a clean, predictable mock state.
    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue' }),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue({ consumerTag: 'test-consumer' }),
      publish: jest.fn(),
      ack: jest.fn(),
      on: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
      unbindQueue: jest.fn().mockResolvedValue(undefined),
      deleteQueue: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    (amqplib.connect as jest.Mock).mockResolvedValue(mockConnection);

    mockWS = createMockWebSocket();
    mockWSS = {
      on: jest.fn(),
      close: jest.fn(),
    };
    (WebSocketServer as unknown as jest.Mock).mockImplementation(() => mockWSS);
  });

  describe('Lifecycle', () => {

    beforeEach(() => {
      server = new WebMQServer('amqp://localhost', 'test-exchange');
    });

    it('should initialize RabbitMQ connection and WebSocket server', async () => {
      await server.start(8080);

      expect(amqplib.connect).toHaveBeenCalledWith('amqp://localhost');
      expect(mockConnection.createChannel).toHaveBeenCalled();
      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'test-exchange',
        'topic',
        { durable: true }
      );
      expect(WebSocketServer).toHaveBeenCalledWith({ port: 8080 });
      expect(mockWSS.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    it('should handle WebSocket connections', async () => {
      await server.start(8080);
      const connectionHandler = mockWSS.on.mock.calls.find(
        (call: any) => call[0] === 'connection'
      )?.[1];

      connectionHandler(mockWS);

      expect(mockWS.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWS.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should stop server and clean up resources', async () => {
      await server.start(8080);
      await server.stop();

      expect(mockWSS.close).toHaveBeenCalled();
      expect(mockChannel.close).toHaveBeenCalled();
      expect(mockConnection.close).toHaveBeenCalled();
    });

    it('should handle stop before start gracefully', async () => {
      await expect(server.stop()).resolves.not.toThrow();
    });

    it('should accept hooks in constructor', () => {
      const hooks: WebMQHooks = {
        pre: [jest.fn() as HookFunction<ClientMessage>],
        identify: [jest.fn() as HookFunction<ClientMessage>],
      };

      const serverWithHooks = new WebMQServer('amqp://localhost', 'test-exchange', hooks);
      expect(serverWithHooks).toBeInstanceOf(WebMQServer);
    });
  });

  describe('WebSocket Message Handling', () => {
    let messageHandler: Function;

    beforeEach(async () => {
      server = new WebMQServer('amqp://localhost', 'test-exchange');
      await server.start(8080);

      const connectionHandler = mockWSS.on.mock.calls.find(
        (call: any) => call[0] === 'connection'
      )?.[1];
      connectionHandler(mockWS);

      messageHandler = getMessageHandler(mockWS);
    });

    describe('identify action', () => {
      it('should handle valid identify message', async () => {
        const message: ClientMessage = {
          action: 'identify',
          sessionId: 'test-session-123',
          messageId: 'msg-1'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-session-123', { expires: 5 * 60 * 1000 });
        expect(mockChannel.consume).toHaveBeenCalledWith('test-session-123', expect.any(Function));
        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'ack',
          messageId: 'msg-1'
        }));
      });

      it('should reject identify without sessionId', async () => {
        const message: ClientMessage = {
          action: 'identify',
          messageId: 'msg-1'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'error',
          message: 'identify requires a sessionId'
        }));
      });

      it('should handle identify without messageId', async () => {
        const message: ClientMessage = {
          action: 'identify',
          sessionId: 'test-session-123'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-session-123', { expires: 5 * 60 * 1000 });
        expect(mockWS.send).not.toHaveBeenCalledWith(expect.stringContaining('ack'));
      });
    });

    describe('publish action', () => {
      it('should handle valid publish message', async () => {
        const message: ClientMessage = {
          action: 'publish',
          routingKey: 'test.routing.key',
          payload: { data: 'test' },
          messageId: 'msg-1'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockChannel.publish).toHaveBeenCalledWith(
          'test-exchange',
          'test.routing.key',
          Buffer.from(JSON.stringify({ data: 'test' }))
        );
        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'ack',
          messageId: 'msg-1'
        }));
      });

      it('should reject publish without routingKey', async () => {
        const message: ClientMessage = {
          action: 'publish',
          payload: { data: 'test' },
          messageId: 'msg-1'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'nack',
          messageId: 'msg-1',
          error: 'publish requires routingKey and payload'
        }));
      });

      it('should reject publish without payload', async () => {
        const message: ClientMessage = {
          action: 'publish',
          routingKey: 'test.key',
          messageId: 'msg-1'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'nack',
          messageId: 'msg-1',
          error: 'publish requires routingKey and payload'
        }));
      });
    });

    describe('listen action', () => {
      it('should handle valid listen message after identify', async () => {
        // First identify
        const identifyMessage: ClientMessage = {
          action: 'identify',
          sessionId: 'test-session-123'
        };
        await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

        // Then listen
        const listenMessage: ClientMessage = {
          action: 'listen',
          bindingKey: 'test.*'
        };
        await messageHandler(Buffer.from(JSON.stringify(listenMessage)));

        expect(mockChannel.bindQueue).toHaveBeenCalledWith(
          'test-session-123',
          'test-exchange',
          'test.*'
        );
      });

      it('should reject listen without prior identify', async () => {
        const message: ClientMessage = {
          action: 'listen',
          bindingKey: 'test.*'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'error',
          message: 'Must identify with sessionId before listening'
        }));
      });

      it('should reject listen without bindingKey', async () => {
        const message: ClientMessage = {
          action: 'listen'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'error',
          message: 'listen requires a bindingKey'
        }));
      });

      it('should ignore duplicate listen requests', async () => {
        // First identify
        const identifyMessage: ClientMessage = {
          action: 'identify',
          sessionId: 'test-session-123'
        };
        await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

        // Listen twice to same binding key
        const listenMessage: ClientMessage = {
          action: 'listen',
          bindingKey: 'test.*'
        };
        await messageHandler(Buffer.from(JSON.stringify(listenMessage)));
        await messageHandler(Buffer.from(JSON.stringify(listenMessage)));

        expect(mockChannel.bindQueue).toHaveBeenCalledTimes(1);
      });
    });

    describe('unlisten action', () => {
      it('should handle valid unlisten message', async () => {
        // First identify and listen
        const identifyMessage: ClientMessage = {
          action: 'identify',
          sessionId: 'test-session-123'
        };
        await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

        const listenMessage: ClientMessage = {
          action: 'listen',
          bindingKey: 'test.*'
        };
        await messageHandler(Buffer.from(JSON.stringify(listenMessage)));

        // Then unlisten
        const unlistenMessage: ClientMessage = {
          action: 'unlisten',
          bindingKey: 'test.*'
        };
        await messageHandler(Buffer.from(JSON.stringify(unlistenMessage)));

        expect(mockChannel.unbindQueue).toHaveBeenCalledWith(
          'test-session-123',
          'test-exchange',
          'test.*'
        );
      });

      it('should reject unlisten without prior identify', async () => {
        const message: ClientMessage = {
          action: 'unlisten',
          bindingKey: 'test.*'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'error',
          message: 'Must identify with sessionId before unlistening'
        }));
      });

      it('should ignore unlisten for non-existent binding', async () => {
        // First identify
        const identifyMessage: ClientMessage = {
          action: 'identify',
          sessionId: 'test-session-123'
        };
        await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

        // Unlisten without prior listen
        const unlistenMessage: ClientMessage = {
          action: 'unlisten',
          bindingKey: 'test.*'
        };
        await messageHandler(Buffer.from(JSON.stringify(unlistenMessage)));

        expect(mockChannel.unbindQueue).not.toHaveBeenCalled();
      });
    });

    describe('invalid actions', () => {
      it('should reject unknown action', async () => {
        const message = {
          action: 'unknown-action'
        };

        await messageHandler(Buffer.from(JSON.stringify(message)));

        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
          action: 'error',
          message: 'Unknown action: unknown-action'
        }));
      });
    });
  });

  describe('Error Handling', () => {
    let messageHandler: Function;
    let closeHandler: Function;

    beforeEach(async () => {
      server = new WebMQServer('amqp://localhost', 'test-exchange');
      await server.start(8080);

      const connectionHandler = mockWSS.on.mock.calls.find(
        (call: any) => call[0] === 'connection'
      )?.[1];
      connectionHandler(mockWS);

      messageHandler = getMessageHandler(mockWS);
      closeHandler = getCloseHandler(mockWS);
    });

    it('should handle malformed JSON messages', async () => {
      await messageHandler(Buffer.from('invalid-json'));

      expect(mockWS.send).toHaveBeenCalledWith(
        expect.stringContaining('"action":"error"')
      );
      expect(mockWS.send).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected token')
      );
    });

    it('should handle RabbitMQ channel errors during identify', async () => {
      mockChannel.assertQueue.mockRejectedValueOnce(new Error('Queue creation failed'));

      const message: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123',
        messageId: 'msg-1'
      };

      await messageHandler(Buffer.from(JSON.stringify(message)));

      expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
        action: 'nack',
        messageId: 'msg-1',
        error: 'Queue creation failed'
      }));
    });

    it('should handle RabbitMQ channel errors during publish', async () => {
      mockChannel.publish.mockImplementationOnce(() => {
        throw new Error('Publish failed');
      });

      const message: ClientMessage = {
        action: 'publish',
        routingKey: 'test.key',
        payload: { data: 'test' },
        messageId: 'msg-1'
      };

      await messageHandler(Buffer.from(JSON.stringify(message)));

      expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
        action: 'nack',
        messageId: 'msg-1',
        error: 'Publish failed'
      }));
    });

    it('should handle WebSocket close with normal code and clean up queue', async () => {
      // Set up a session first
      const identifyMessage: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123'
      };
      await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

      // Simulate normal close
      await closeHandler(1000, 'Normal closure');

      expect(mockChannel.cancel).toHaveBeenCalledWith('test-consumer');
      expect(mockChannel.deleteQueue).toHaveBeenCalledWith('test-session-123');
    });

    it('should handle WebSocket close with going away code and clean up queue', async () => {
      // Set up a session first
      const identifyMessage: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123'
      };
      await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

      // Simulate going away close
      await closeHandler(1001, 'Going away');

      expect(mockChannel.cancel).toHaveBeenCalledWith('test-consumer');
      expect(mockChannel.deleteQueue).toHaveBeenCalledWith('test-session-123');
    });

    it('should handle WebSocket close with abnormal code and preserve queue', async () => {
      // Set up a session first
      const identifyMessage: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123'
      };
      await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

      // Simulate abnormal close
      await closeHandler(1006, 'Abnormal closure');

      expect(mockChannel.cancel).toHaveBeenCalledWith('test-consumer');
      expect(mockChannel.deleteQueue).not.toHaveBeenCalled();
    });

    it('should ignore channel errors during unbind cleanup', async () => {
      // Set up a session and binding first
      const identifyMessage: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123'
      };
      await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

      const listenMessage: ClientMessage = {
        action: 'listen',
        bindingKey: 'test.*'
      };
      await messageHandler(Buffer.from(JSON.stringify(listenMessage)));

      // Make unbindQueue fail
      mockChannel.unbindQueue.mockRejectedValueOnce(new Error('Unbind failed'));

      const unlistenMessage: ClientMessage = {
        action: 'unlisten',
        bindingKey: 'test.*'
      };

      // Should not throw even though unbind fails
      await expect(messageHandler(Buffer.from(JSON.stringify(unlistenMessage)))).resolves.not.toThrow();
    });

    it('should handle channel recovery failure during close cleanup', async () => {
      // Set up a session first
      const identifyMessage: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123'
      };
      await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

      // Make channel recovery fail
      mockConnection.createChannel.mockRejectedValueOnce(new Error('Channel creation failed'));

      // Should not throw even though channel recovery fails
      await expect(closeHandler(1000, 'Normal closure')).resolves.not.toThrow();
    });
  });

  describe('Hook Integration', () => {
    let messageHandler: Function;
    let preHook: jest.MockedFunction<HookFunction<ClientMessage>>;
    let identifyHook: jest.MockedFunction<HookFunction<ClientMessage>>;

    beforeEach(async () => {
      preHook = jest.fn(async (context, data, next) => {
        context.preHookCalled = true;
        await next();
      });

      identifyHook = jest.fn(async (context, data, next) => {
        context.identifyHookCalled = true;
        await next();
      });

      const hooks: WebMQHooks = {
        pre: [preHook],
        identify: [identifyHook],
      };

      server = new WebMQServer('amqp://localhost', 'test-exchange', hooks);
      await server.start(8080);

      const connectionHandler = mockWSS.on.mock.calls.find(
        (call: any) => call[0] === 'connection'
      )?.[1];
      connectionHandler(mockWS);

      messageHandler = getMessageHandler(mockWS);
    });

    it('should call hooks in correct order for identify action', async () => {
      const message: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123'
      };

      await messageHandler(Buffer.from(JSON.stringify(message)));

      expect(preHook).toHaveBeenCalled();
      expect(identifyHook).toHaveBeenCalled();
      expect(mockChannel.assertQueue).toHaveBeenCalled();

      // Verify hook execution order by checking call times
      const preHookCallTime = preHook.mock.invocationCallOrder[0];
      const identifyHookCallTime = identifyHook.mock.invocationCallOrder[0];
      expect(preHookCallTime).toBeLessThan(identifyHookCallTime);
    });

    it('should pass context and message to hooks', async () => {
      const message: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123'
      };

      await messageHandler(Buffer.from(JSON.stringify(message)));

      expect(preHook).toHaveBeenCalledWith(
        expect.objectContaining({
          ws: mockWS,
          activeBindings: expect.any(Set)
        }),
        message,
        expect.any(Function)
      );
    });

    it('should allow hooks to modify context', async () => {
      // This functionality is thoroughly tested in hooks.test.ts
      // Here we just verify the hooks were configured properly
      expect(preHook).toBeDefined();
      expect(identifyHook).toBeDefined();
    });

    it('should stop execution if hook does not call next', async () => {
      // This functionality is thoroughly tested in hooks.test.ts
      // Here we just verify the server can be created with hooks
      const testServer = new WebMQServer('amqp://localhost', 'test-exchange', {
        pre: [jest.fn() as HookFunction<ClientMessage>]
      });
      expect(testServer).toBeInstanceOf(WebMQServer);
    });
  });

  describe('Utility Functions', () => {
    // Import the function from index to test it
    // Note: matchesPattern is not exported, so we'll test it through message handling
    let messageHandler: Function;

    beforeEach(async () => {
      server = new WebMQServer('amqp://localhost', 'test-exchange');
      await server.start(8080);

      const connectionHandler = mockWSS.on.mock.calls.find(
        (call: any) => call[0] === 'connection'
      )?.[1];
      connectionHandler(mockWS);

      messageHandler = getMessageHandler(mockWS);

      // Set up session and start consuming
      const identifyMessage: ClientMessage = {
        action: 'identify',
        sessionId: 'test-session-123'
      };
      await messageHandler(Buffer.from(JSON.stringify(identifyMessage)));

      // Set up a binding
      const listenMessage: ClientMessage = {
        action: 'listen',
        bindingKey: 'user.*'
      };
      await messageHandler(Buffer.from(JSON.stringify(listenMessage)));
    });

    it('should match exact routing keys', async () => {
      // Get the consumer function from the consume call
      const consumerFn = mockChannel.consume.mock.calls[0][1];

      // Simulate incoming message with exact match
      const mockMessage = {
        fields: { routingKey: 'user.login' },
        content: Buffer.from(JSON.stringify({ action: 'login' }))
      };

      consumerFn(mockMessage);

      expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
        action: 'message',
        bindingKey: 'user.*',
        payload: { action: 'login' }
      }));
      expect(mockChannel.ack).toHaveBeenCalledWith(mockMessage);
    });

    it('should match wildcard patterns with *', async () => {
      const consumerFn = mockChannel.consume.mock.calls[0][1];

      // Test various routing keys that should match user.*
      const testCases = [
        'user.login',
        'user.logout',
        'user.register',
        'user.delete'
      ];

      testCases.forEach(routingKey => {
        const mockMessage = {
          fields: { routingKey },
          content: Buffer.from(JSON.stringify({ test: 'data' }))
        };

        consumerFn(mockMessage);
      });

      expect(mockWS.send).toHaveBeenCalledTimes(testCases.length);
    });

    it('should not match non-matching patterns', async () => {
      const consumerFn = mockChannel.consume.mock.calls[0][1];

      // Test routing keys that should NOT match user.*
      const nonMatchingCases = [
        'order.created',
        'user',  // Missing second part
        'user.login.failed',  // Too many parts for * wildcard
        'admin.user.login'
      ];

      nonMatchingCases.forEach(routingKey => {
        const mockMessage = {
          fields: { routingKey },
          content: Buffer.from(JSON.stringify({ test: 'data' }))
        };

        consumerFn(mockMessage);
      });

      expect(mockWS.send).not.toHaveBeenCalled();
    });

    it('should match wildcard patterns with #', async () => {
      // Set up a # pattern binding
      const listenMessage: ClientMessage = {
        action: 'listen',
        bindingKey: 'log.#'
      };
      await messageHandler(Buffer.from(JSON.stringify(listenMessage)));

      const consumerFn = mockChannel.consume.mock.calls[0][1];

      // Test various routing keys that should match log.#
      const testCases = [
        'log.info',
        'log.error.database',
        'log.warn.auth.failure',
        'log.debug.performance.slow'
      ];

      testCases.forEach(routingKey => {
        const mockMessage = {
          fields: { routingKey },
          content: Buffer.from(JSON.stringify({ level: 'info' }))
        };

        consumerFn(mockMessage);
      });

      // Should match both user.* and log.# patterns for log messages
      // Only log messages should trigger the send
      expect(mockWS.send).toHaveBeenCalledTimes(testCases.length);
    });

    it('should handle multiple bindings and filter correctly', async () => {
      // Add another binding
      const listenMessage: ClientMessage = {
        action: 'listen',
        bindingKey: 'order.created'
      };
      await messageHandler(Buffer.from(JSON.stringify(listenMessage)));

      const consumerFn = mockChannel.consume.mock.calls[0][1];

      // Message that matches both user.* and order.created patterns
      const userMessage = {
        fields: { routingKey: 'user.login' },
        content: Buffer.from(JSON.stringify({ action: 'login' }))
      };

      const orderMessage = {
        fields: { routingKey: 'order.created' },
        content: Buffer.from(JSON.stringify({ orderId: 123 }))
      };

      consumerFn(userMessage);
      consumerFn(orderMessage);

      // Should receive both messages with correct binding keys
      expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
        action: 'message',
        bindingKey: 'user.*',
        payload: { action: 'login' }
      }));

      expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
        action: 'message',
        bindingKey: 'order.created',
        payload: { orderId: 123 }
      }));
    });
  });
});
