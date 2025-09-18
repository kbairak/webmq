import {
  WebMQServer, ClientMessage, Hook, WebSocketManager, RabbitMQManager, WebSocketConnectionData, setLogLevel
} from './index';

// Disable all logging during tests
setLogLevel('silent');
import { WebSocket, WebSocketServer } from 'ws'; // Import WebSocket and WebSocketServer
import amqplib from 'amqplib';

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
  };

  const mockConnection = {
    createChannel: jest.fn().mockResolvedValue(mockChannel),
    close: jest.fn(),
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


// --- Integration Tests with Mocked Abstractions ---

describe('WebMQServer Integration (Mocked Abstractions)', () => {
  let server: WebMQServer;
  let mockWebSocketManager: jest.Mocked<WebSocketManager>;
  let mockRabbitMQManager: jest.Mocked<RabbitMQManager>;
  let mockWS: jest.Mocked<WebSocket>;
  let mockConnection: WebSocketConnectionData;
  let eventLog: Array<{ event: string, data: any }>;

  beforeEach(() => {
    jest.clearAllMocks();
    eventLog = [];

    mockWS = {
      on: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      readyState: 1, // WebSocket.OPEN
    } as any;

    mockConnection = {
      ws: mockWS,
      subscriptions: new Map(),
      context: { ws: mockWS, id: 'test-connection-id' }
    };

    // Set up standard mock returns
    mockWebSocketManager = {
      createConnection: jest.fn(),
      getConnection: jest.fn(),
      removeConnection: jest.fn(),
      getAllConnections: jest.fn(),
      getConnectionIds: jest.fn(),
      size: jest.fn(),
    } as any;
    mockWebSocketManager.createConnection.mockReturnValue('test-connection-id');
    mockWebSocketManager.getConnection.mockReturnValue(mockConnection);
    mockWebSocketManager.removeConnection.mockReturnValue(true);

    mockRabbitMQManager = {
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      cleanupSubscriptions: jest.fn(),
      publish: jest.fn(),
    } as any;
    mockRabbitMQManager.subscribe.mockResolvedValue({
      queue: 'test-queue',
      consumerTag: 'test-consumer'
    });

    // Mock the backend to use our mocked managers
    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange'
    });

    // Replace the managers with our mocks (this requires exposing them or using dependency injection)
    (server as any).webSocketManager = mockWebSocketManager;
    (server as any).rabbitMQManager = mockRabbitMQManager;
    (server as any).channel = {}; // Mock channel exists

    // Set up event logging
    const events = ['client.connected', 'client.disconnected', 'message.received', 'message.processed', 'subscription.created', 'subscription.removed', 'error'];
    events.forEach(eventName => {
      server.on(eventName as any, (data: any) => {
        eventLog.push({ event: eventName, data });
      });
    });
  });

  describe('message processing flow', () => {
    it('should handle publish message with mocked abstractions', async () => {
      // Arrange
      const emitMessage: ClientMessage = {
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 'test' }
      };

      // Act
      await (server as any).processMessage('test-connection-id', emitMessage);

      // Assert
      expect(mockWebSocketManager.getConnection).toHaveBeenCalledWith('test-connection-id');
      expect(mockRabbitMQManager.publish).toHaveBeenCalledWith('test.route', { data: 'test' });
    });

    it('should handle listen message with mocked abstractions', async () => {
      // Arrange
      const listenMessage: ClientMessage = {
        action: 'listen',
        bindingKey: 'test.topic'
      };

      // Act
      await (server as any).processMessage('test-connection-id', listenMessage);

      // Assert
      expect(mockWebSocketManager.getConnection).toHaveBeenCalledWith('test-connection-id');
      expect(mockRabbitMQManager.subscribe).toHaveBeenCalledWith('test.topic', expect.any(Function));
      expect(mockConnection.subscriptions.has('test.topic')).toBe(true);

      // Check subscription.created event (this is emitted from executeAction)
      const subscriptionEvent = eventLog.find(e => e.event === 'subscription.created');
      expect(subscriptionEvent).toBeDefined();
      expect(subscriptionEvent!.data.connectionId).toBe('test-connection-id');
      expect(subscriptionEvent!.data.bindingKey).toBe('test.topic');
      expect(subscriptionEvent!.data.queue).toBe('test-queue');
    });

    it('should handle unlisten message with mocked abstractions', async () => {
      // Arrange
      const subscription = { queue: 'test-queue', consumerTag: 'test-consumer' };
      mockConnection.subscriptions.set('test.topic', subscription);

      const unlistenMessage: ClientMessage = {
        action: 'unlisten',
        bindingKey: 'test.topic'
      };

      // Act
      await (server as any).processMessage('test-connection-id', unlistenMessage);

      // Assert
      expect(mockWebSocketManager.getConnection).toHaveBeenCalledWith('test-connection-id');
      expect(mockRabbitMQManager.unsubscribe).toHaveBeenCalledWith(subscription, 'test.topic');
      expect(mockConnection.subscriptions.has('test.topic')).toBe(false);

      // Check subscription.removed event (this is emitted from executeAction)
      const subscriptionRemovedEvent = eventLog.find(e => e.event === 'subscription.removed');
      expect(subscriptionRemovedEvent).toBeDefined();
      expect(subscriptionRemovedEvent!.data.connectionId).toBe('test-connection-id');
      expect(subscriptionRemovedEvent!.data.bindingKey).toBe('test.topic');
    });
  });

  describe('connection lifecycle with mocked abstractions', () => {
    it('should handle connection cleanup', async () => {
      // Arrange
      const subscription = { queue: 'test-queue', consumerTag: 'test-consumer' };
      mockConnection.subscriptions.set('test.topic', subscription);

      // Act
      await (server as any).cleanup('test-connection-id');

      // Assert
      expect(mockWebSocketManager.getConnection).toHaveBeenCalledWith('test-connection-id');
      expect(mockRabbitMQManager.cleanupSubscriptions).toHaveBeenCalledWith(mockConnection.subscriptions);
      expect(mockWebSocketManager.removeConnection).toHaveBeenCalledWith('test-connection-id');

      // Check client.disconnected event
      const disconnectedEvent = eventLog.find(e => e.event === 'client.disconnected');
      expect(disconnectedEvent).toBeDefined();
      expect(disconnectedEvent!.data.connectionId).toBe('test-connection-id');
    });

    it('should handle missing connection during cleanup', async () => {
      // Arrange
      mockWebSocketManager.getConnection.mockReturnValue(undefined);
      // Act
      await (server as any).cleanup('invalid-connection-id');

      // Assert
      expect(mockRabbitMQManager.cleanupSubscriptions).not.toHaveBeenCalled();
      expect(mockWebSocketManager.removeConnection).not.toHaveBeenCalled();
    });
  });

  describe('error handling with mocked abstractions', () => {
    it('should handle missing connection during message processing', async () => {
      // Arrange
      mockWebSocketManager.getConnection.mockReturnValue(undefined);
      const message: ClientMessage = { action: 'publish', routingKey: 'test', payload: {} };

      // Act & Assert
      await expect((server as any).processMessage('invalid-id', message))
        .rejects.toThrow('Connection invalid-id not found');
    });

    it('should handle subscription manager errors', async () => {
      // Arrange
      const listenMessage: ClientMessage = {
        action: 'listen',
        bindingKey: 'test.topic'
      };
      mockRabbitMQManager.subscribe.mockRejectedValue(new Error('RabbitMQSubscription failed'));

      // Act & Assert
      await expect((server as any).processMessage('test-connection-id', listenMessage))
        .rejects.toThrow('RabbitMQSubscription failed');

      expect(mockWebSocketManager.getConnection).toHaveBeenCalledWith('test-connection-id');
      expect(mockRabbitMQManager.subscribe).toHaveBeenCalledWith('test.topic', expect.any(Function));
    });
  });
});

// --- Additional Coverage Tests ---

describe('WebMQServer start method', () => {
  let server: WebMQServer;
  let mockConnection: any;
  let mockChannel: any;

  beforeEach(() => {
    // Mock amqplib
    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue' }),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue({ consumerTag: 'test-consumer' }),
      publish: jest.fn(),
      ack: jest.fn(),
    };

    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
    };

    // Mock amqplib.connect
    (amqplib.connect as jest.Mock).mockResolvedValue(mockConnection);

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange',
    });
  });

  it('should initialize RabbitMQ connection and WebSocket server', async () => {
    // Arrange
    const mockWSS = {
      on: jest.fn(),
    };
    (WebSocketServer as unknown as jest.Mock).mockImplementation(() => mockWSS);
    // Act
    await server.start(8080);

    // Assert
    expect(amqplib.connect).toHaveBeenCalledWith('amqp://localhost');
    expect(mockConnection.createChannel).toHaveBeenCalled();
    expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', { durable: true });
    expect(WebSocketServer).toHaveBeenCalledWith({ port: 8080 });
    expect(mockWSS.on).toHaveBeenCalledWith('connection', expect.any(Function));
  });

  it('should handle WebSocket connections', async () => {
    // Arrange
    const mockWS = {
      on: jest.fn(),
    };
    const mockWSS = {
      on: jest.fn(),
    };
    (WebSocketServer as unknown as jest.Mock).mockImplementation(() => mockWSS);
    // Act
    await server.start(8080);
    const connectionHandler = mockWSS.on.mock.calls.find((call: any) => call[0] === 'connection')?.[1];
    if (connectionHandler) {
      connectionHandler(mockWS);
    }

    // Assert
    expect(mockWS.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockWS.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('should throw error if channel not established during connection', async () => {
    // Arrange
    const mockWS = {};
    const mockWSS = {
      on: jest.fn(),
    };
    (WebSocketServer as unknown as jest.Mock).mockImplementation(() => mockWSS);

    // Act
    await server.start(8080);
    // Manually clear the channel to simulate error condition
    (server as any).channel = null;
    const connectionHandler = mockWSS.on.mock.calls.find((call: any) => call[0] === 'connection')?.[1];

    // Assert
    expect(() => {
      if (connectionHandler) {
        connectionHandler(mockWS);
      }
    }).toThrow('Shared channel not established.');
  });
});

describe('Hook system', () => {
  let server: WebMQServer;
  let mockWebSocketManager: jest.Mocked<WebSocketManager>;
  let mockRabbitMQManager: jest.Mocked<RabbitMQManager>;
  let mockConnection: WebSocketConnectionData;
  let hookExecutionLog: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    hookExecutionLog = [];

    mockConnection = {
      ws: {} as any,
      subscriptions: new Map(),
      context: { ws: {} as any, id: 'test-connection-id' }
    };

    mockWebSocketManager = {
      createConnection: jest.fn().mockReturnValue('test-connection-id'),
      getConnection: jest.fn().mockReturnValue(mockConnection),
      removeConnection: jest.fn().mockReturnValue(true),
      getAllConnections: jest.fn(),
      getConnectionIds: jest.fn(),
      size: jest.fn(),
    } as any;

    mockRabbitMQManager = {
      subscribe: jest.fn().mockResolvedValue({ queue: 'test-queue', consumerTag: 'test-consumer' }),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      cleanupSubscriptions: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;
  });

  it('should execute pre hooks before action hooks', async () => {
    // Arrange
    const preHook = jest.fn(async (ctx, msg, next) => {
      hookExecutionLog.push('pre');
      await next();
    });
    const listenHook = jest.fn(async (ctx, msg, next) => {
      hookExecutionLog.push('listen');
      await next();
    });

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange',
      hooks: {
        pre: [preHook],
        onListen: [listenHook],
      }
    });

    (server as any).webSocketManager = mockWebSocketManager;
    (server as any).rabbitMQManager = mockRabbitMQManager;
    (server as any).channel = {};

    const message: ClientMessage = {
      action: 'listen',
      bindingKey: 'test.topic'
    };

    // Act
    await (server as any).processMessage('test-connection-id', message);

    // Assert
    expect(hookExecutionLog).toEqual(['pre', 'listen']);
    expect(preHook).toHaveBeenCalledWith(mockConnection.context, message, expect.any(Function));
    expect(listenHook).toHaveBeenCalledWith(mockConnection.context, message, expect.any(Function));
  });

  it('should execute hooks in correct order for publish action', async () => {
    // Arrange
    const preHook = jest.fn(async (ctx, msg, next) => {
      hookExecutionLog.push('pre');
      await next();
    });
    const emitHook = jest.fn(async (ctx, msg, next) => {
      hookExecutionLog.push('publish');
      await next();
    });

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange',
      hooks: {
        pre: [preHook],
        onPublish: [emitHook],
      }
    });

    (server as any).webSocketManager = mockWebSocketManager;
    (server as any).rabbitMQManager = mockRabbitMQManager;
    (server as any).channel = {};

    const message: ClientMessage = {
      action: 'publish',
      routingKey: 'test.route',
      payload: { data: 'test' }
    };

    // Act
    await (server as any).processMessage('test-connection-id', message);

    // Assert
    expect(hookExecutionLog).toEqual(['pre', 'publish']);
  });

  it('should execute hooks in correct order for unlisten action', async () => {
    // Arrange
    const preHook = jest.fn(async (ctx, msg, next) => {
      hookExecutionLog.push('pre');
      await next();
    });
    const unlistenHook = jest.fn(async (ctx, msg, next) => {
      hookExecutionLog.push('unlisten');
      await next();
    });

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange',
      hooks: {
        pre: [preHook],
        onUnlisten: [unlistenHook],
      }
    });

    (server as any).webSocketManager = mockWebSocketManager;
    (server as any).rabbitMQManager = mockRabbitMQManager;
    (server as any).channel = {};

    // Set up existing subscription
    mockConnection.subscriptions.set('test.topic', { queue: 'test-queue', consumerTag: 'test-consumer' });

    const message: ClientMessage = {
      action: 'unlisten',
      bindingKey: 'test.topic'
    };

    // Act
    await (server as any).processMessage('test-connection-id', message);

    // Assert
    expect(hookExecutionLog).toEqual(['pre', 'unlisten']);
  });

  it('should handle hooks that modify context', async () => {
    // Arrange
    const contextModifyingHook = jest.fn(async (ctx, msg, next) => {
      ctx.userId = 'user-123';
      ctx.authenticated = true;
      await next();
    });

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange',
      hooks: {
        pre: [contextModifyingHook],
      }
    });

    (server as any).webSocketManager = mockWebSocketManager;
    (server as any).rabbitMQManager = mockRabbitMQManager;
    (server as any).channel = {};

    const message: ClientMessage = {
      action: 'publish',
      routingKey: 'test.route',
      payload: { data: 'test' }
    };

    // Act
    await (server as any).processMessage('test-connection-id', message);

    // Assert
    expect(mockConnection.context.userId).toBe('user-123');
    expect(mockConnection.context.authenticated).toBe(true);
  });

  it('should use only pre hooks for unknown actions', async () => {
    // Arrange
    const preHook = jest.fn(async (ctx, msg, next) => {
      hookExecutionLog.push('pre');
      await next();
    });

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange',
      hooks: {
        pre: [preHook],
      }
    });

    (server as any).webSocketManager = mockWebSocketManager;
    (server as any).rabbitMQManager = mockRabbitMQManager;
    (server as any).channel = {};

    // Test the getHooksForAction method with unknown action
    const hooks = (server as any).getHooksForAction('unknown' as any);

    // Assert
    expect(hooks).toEqual([preHook]);
  });
});

describe('WebSocket message handling', () => {
  let server: WebMQServer;
  let mockWebSocketManager: jest.Mocked<WebSocketManager>;
  let mockRabbitMQManager: jest.Mocked<RabbitMQManager>;
  let mockConnection: WebSocketConnectionData;
  let mockWS: jest.Mocked<WebSocket>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockWS = {
      on: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      readyState: 1, // WebSocket.OPEN
    } as any;

    mockConnection = {
      ws: mockWS,
      subscriptions: new Map(),
      context: { ws: mockWS, id: 'test-connection-id' }
    };

    mockWebSocketManager = {
      createConnection: jest.fn().mockReturnValue('test-connection-id'),
      getConnection: jest.fn().mockReturnValue(mockConnection),
      removeConnection: jest.fn().mockReturnValue(true),
      getAllConnections: jest.fn(),
      getConnectionIds: jest.fn(),
      size: jest.fn(),
    } as any;

    mockRabbitMQManager = {
      subscribe: jest.fn().mockResolvedValue({ queue: 'test-queue', consumerTag: 'test-consumer' }),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      cleanupSubscriptions: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange'
    });

    (server as any).webSocketManager = mockWebSocketManager;
    (server as any).rabbitMQManager = mockRabbitMQManager;
    (server as any).channel = {};
  });

  it('should handle malformed JSON messages', async () => {
    // Arrange
    const mockWSS = { on: jest.fn() };
    (WebSocketServer as unknown as jest.Mock).mockImplementation(() => mockWSS);

    // Add error event listener to prevent unhandled error
    const errorEvents: any[] = [];
    server.on('error', (data) => {
      errorEvents.push(data);
    });

    // Act
    await server.start(8080);
    const connectionHandler = mockWSS.on.mock.calls.find((call: any) => call[0] === 'connection')?.[1];
    if (connectionHandler) {
      connectionHandler(mockWS);
    }

    // Get the message handler and simulate malformed JSON
    const messageHandler = mockWS.on.mock.calls.find((call: any) => call[0] === 'message')?.[1];
    if (messageHandler) {
      await messageHandler.call(mockWS as any, Buffer.from('invalid json'));
    }

    // Assert
    // Check that WebSocket.send was called with error message
    expect(mockWS.send).toHaveBeenCalledTimes(1);
    const sentData = mockWS.send.mock.calls[0][0];
    const sentMessage = JSON.parse(sentData.toString());
    expect(sentMessage.action).toBe('error');
    expect(sentMessage.message).toContain('Unexpected token');

    // Check that error event was emitted
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].connectionId).toBe('test-connection-id');
    expect(errorEvents[0].context).toBe('message processing');
    expect(errorEvents[0].error.message).toContain('Unexpected token');

  });

  it('should send messages to WebSocket clients through message handler', async () => {
    // Arrange
    const testPayload = { user: 'john', message: 'hello world' };
    let messageHandlerCallback: ((msg: any) => void) | undefined;

    // Capture the message handler callback when subscribe is called
    mockRabbitMQManager.subscribe.mockImplementation(async (bindingKey, handler) => {
      messageHandlerCallback = handler;
      return { queue: 'test-queue', consumerTag: 'test-consumer' };
    });

    const message: ClientMessage = {
      action: 'listen',
      bindingKey: 'chat.room.1'
    };

    // Act
    await (server as any).processMessage('test-connection-id', message);

    // Simulate a RabbitMQ message being received
    const mockRabbitMsg = {
      content: Buffer.from(JSON.stringify(testPayload))
    };
    messageHandlerCallback!(mockRabbitMsg);

    // Assert
    expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
      action: 'message',
      bindingKey: 'chat.room.1',
      payload: testPayload,
    }));
  });

  it('should handle WebSocket close events', async () => {
    // Arrange
    // Test the cleanup method directly since that's what the close handler calls
    await (server as any).cleanup('test-connection-id');

    // Assert
    expect(mockWebSocketManager.getConnection).toHaveBeenCalledWith('test-connection-id');
    expect(mockRabbitMQManager.cleanupSubscriptions).toHaveBeenCalledWith(mockConnection.subscriptions);
    expect(mockWebSocketManager.removeConnection).toHaveBeenCalledWith('test-connection-id');
  });

  it('should publish events during message processing', async () => {
    // Arrange
    const mockWSS = { on: jest.fn() };
    (WebSocketServer as unknown as jest.Mock).mockImplementation(() => mockWSS);
    const eventLog: Array<{ event: string, data: any }> = [];

    // Set up event logging
    const events = ['message.received', 'message.processed', 'error'];
    events.forEach(eventName => {
      server.on(eventName as any, (data: any) => {
        eventLog.push({ event: eventName, data });
      });
    });

    const validMessage = {
      action: 'publish',
      routingKey: 'test.route',
      payload: { data: 'test' }
    };

    // Act
    await server.start(8080);
    const connectionHandler = mockWSS.on.mock.calls.find((call: any) => call[0] === 'connection')?.[1];
    if (connectionHandler) {
      connectionHandler(mockWS);
    }

    // Get the message handler and simulate valid message
    const messageHandler = mockWS.on.mock.calls.find((call: any) => call[0] === 'message')?.[1];
    if (messageHandler) {
      await messageHandler.call(mockWS as any, Buffer.from(JSON.stringify(validMessage)));
    }

    // Assert
    expect(eventLog).toContainEqual({
      event: 'message.received',
      data: { connectionId: 'test-connection-id', message: validMessage }
    });
    expect(eventLog).toContainEqual({
      event: 'message.processed',
      data: { connectionId: 'test-connection-id', message: validMessage }
    });
  });
});

describe('Error scenarios', () => {
  let server: WebMQServer;
  let mockWebSocketManager: jest.Mocked<WebSocketManager>;
  let mockRabbitMQManager: jest.Mocked<RabbitMQManager>;
  let mockConnection: WebSocketConnectionData;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnection = {
      ws: {} as any,
      subscriptions: new Map(),
      context: { ws: {} as any, id: 'test-connection-id' }
    };

    mockWebSocketManager = {
      createConnection: jest.fn().mockReturnValue('test-connection-id'),
      getConnection: jest.fn().mockReturnValue(mockConnection),
      removeConnection: jest.fn().mockReturnValue(true),
      getAllConnections: jest.fn(),
      getConnectionIds: jest.fn(),
      size: jest.fn(),
    } as any;

    mockRabbitMQManager = {
      subscribe: jest.fn().mockResolvedValue({ queue: 'test-queue', consumerTag: 'test-consumer' }),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      cleanupSubscriptions: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;

    server = new WebMQServer({
      rabbitmqUrl: 'amqp://localhost',
      exchangeName: 'test-exchange'
    });

    (server as any).webSocketManager = mockWebSocketManager;
    (server as any).rabbitMQManager = mockRabbitMQManager;
    (server as any).channel = {};
  });

  it('should handle missing routingKey in publish', async () => {
    // Arrange
    const message: ClientMessage = {
      action: 'publish',
      payload: { data: 'test' }
      // Missing routingKey
    };

    // Act & Assert
    await expect((server as any).processMessage('test-connection-id', message))
      .rejects.toThrow('publish requires routingKey and payload');
  });

  it('should handle missing payload in publish', async () => {
    // Arrange
    const message: ClientMessage = {
      action: 'publish',
      routingKey: 'test.route'
      // Missing payload
    };

    // Act & Assert
    await expect((server as any).processMessage('test-connection-id', message))
      .rejects.toThrow('publish requires routingKey and payload');
  });

  it('should handle missing bindingKey in listen', async () => {
    // Arrange
    const message: ClientMessage = {
      action: 'listen'
      // Missing bindingKey
    };

    // Act & Assert
    await expect((server as any).processMessage('test-connection-id', message))
      .rejects.toThrow('listen requires a bindingKey');
  });

  it('should handle missing bindingKey in unlisten', async () => {
    // Arrange
    const message: ClientMessage = {
      action: 'unlisten'
      // Missing bindingKey
    };

    // Act & Assert
    await expect((server as any).processMessage('test-connection-id', message))
      .rejects.toThrow('unlisten requires a bindingKey');
  });

  it('should handle unknown action types', async () => {
    // Arrange
    const message = {
      action: 'unknown-action'
    } as any;

    // Act & Assert
    await expect((server as any).processMessage('test-connection-id', message))
      .rejects.toThrow('Unknown action: unknown-action');
  });

  it('should handle already existing subscriptions in listen', async () => {
    // Arrange
    mockConnection.subscriptions.set('test.topic', { queue: 'existing-queue', consumerTag: 'existing-consumer' });

    const message: ClientMessage = {
      action: 'listen',
      bindingKey: 'test.topic'
    };

    // Act
    await (server as any).processMessage('test-connection-id', message);

    // Assert
    expect(mockRabbitMQManager.subscribe).not.toHaveBeenCalled();

  });

  it('should handle non-existent subscription in unlisten', async () => {
    // Arrange

    const message: ClientMessage = {
      action: 'unlisten',
      bindingKey: 'non-existent-topic'
    };

    // Act
    await (server as any).processMessage('test-connection-id', message);

    // Assert
    expect(mockRabbitMQManager.unsubscribe).not.toHaveBeenCalled();

  });

  it('should handle missing connection or channel in executeAction', async () => {
    // Arrange
    const message: ClientMessage = {
      action: 'publish',
      routingKey: 'test.route',
      payload: { data: 'test' }
    };

    // Test with missing subscription manager
    (server as any).rabbitMQManager = null;

    // Act & Assert
    await expect((server as any).processMessage('test-connection-id', message))
      .rejects.toThrow('Connection test-connection-id or shared channel not available');
  });

  it('should log action execution steps', async () => {
    // Arrange
    const message: ClientMessage = {
      action: 'publish',
      routingKey: 'test.route',
      payload: { data: 'test' }
    };

    // Act
    await (server as any).processMessage('test-connection-id', message);

    // Assert

  });
});


// --- Individual Component Tests ---

describe('WebSocketManager', () => {
  let manager: WebSocketManager;
  let mockWS: jest.Mocked<WebSocket>;

  beforeEach(() => {
    manager = new WebSocketManager();
    mockWS = {
      on: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
    } as any;
  });

  describe('createConnection', () => {
    it('should create a connection with unique ID', () => {
      // Act
      const id1 = manager.createConnection(mockWS);
      const id2 = manager.createConnection(mockWS);

      // Assert
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(manager.size()).toBe(2);
    });

    it('should store connection data correctly', () => {
      // Act
      const id = manager.createConnection(mockWS);
      const connection = manager.getConnection(id);

      // Assert
      expect(connection).toBeDefined();
      expect(connection!.ws).toBe(mockWS);
      expect(connection!.context.id).toBe(id);
      expect(connection!.context.ws).toBe(mockWS);
      expect(connection!.subscriptions).toBeInstanceOf(Map);
      expect(connection!.subscriptions.size).toBe(0);
    });
  });

  describe('getConnection', () => {
    it('should return connection data for valid ID', () => {
      // Arrange
      const id = manager.createConnection(mockWS);

      // Act
      const connection = manager.getConnection(id);

      // Assert
      expect(connection).toBeDefined();
      expect(connection!.context.id).toBe(id);
    });

    it('should return undefined for invalid ID', () => {
      // Act
      const connection = manager.getConnection('invalid-id');

      // Assert
      expect(connection).toBeUndefined();
    });
  });

  describe('removeConnection', () => {
    it('should remove connection and return true for valid ID', () => {
      // Arrange
      const id = manager.createConnection(mockWS);
      expect(manager.size()).toBe(1);

      // Act
      const removed = manager.removeConnection(id);

      // Assert
      expect(removed).toBe(true);
      expect(manager.size()).toBe(0);
      expect(manager.getConnection(id)).toBeUndefined();
    });

    it('should return false for invalid ID', () => {
      // Act
      const removed = manager.removeConnection('invalid-id');

      // Assert
      expect(removed).toBe(false);
    });
  });

  describe('utility methods', () => {
    it('should return all connections', () => {
      // Arrange
      const id1 = manager.createConnection(mockWS);
      const id2 = manager.createConnection(mockWS);

      // Act
      const connections = manager.getAllConnections();

      // Assert
      expect(connections).toHaveLength(2);
      expect(connections.map(c => c.context.id)).toEqual(expect.arrayContaining([id1, id2]));
    });

    it('should return connection IDs', () => {
      // Arrange
      const id1 = manager.createConnection(mockWS);
      const id2 = manager.createConnection(mockWS);

      // Act
      const ids = manager.getConnectionIds();

      // Assert
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([id1, id2]));
    });

    it('should track size correctly', () => {
      // Arrange & Act & Assert (sequential operations)
      expect(manager.size()).toBe(0);

      const id1 = manager.createConnection(mockWS);
      expect(manager.size()).toBe(1);

      const id2 = manager.createConnection(mockWS);
      expect(manager.size()).toBe(2);

      manager.removeConnection(id1);
      expect(manager.size()).toBe(1);

      manager.removeConnection(id2);
      expect(manager.size()).toBe(0);
    });
  });
});

describe('RabbitMQManager', () => {
  let manager: RabbitMQManager;
  let mockChannel: any;

  beforeEach(() => {
    mockChannel = {
      assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue-123' }),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue({ consumerTag: 'consumer-456' }),
      cancel: jest.fn().mockResolvedValue(undefined),
      unbindQueue: jest.fn().mockResolvedValue(undefined),
      deleteQueue: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn(),
      ack: jest.fn(),
    };

    manager = new RabbitMQManager(mockChannel, 'test-exchange');
  });

  describe('subscribe', () => {
    it('should create a subscription correctly', async () => {
      // Act
      const messageHandler = jest.fn();
      const subscription = await manager.subscribe('test.topic', messageHandler);

      // Assert
      expect(subscription.queue).toBe('test-queue-123');
      expect(subscription.consumerTag).toBe('consumer-456');

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('', {
        exclusive: true,
        autoDelete: true
      });
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue-123', 'test-exchange', 'test.topic');
      expect(mockChannel.consume).toHaveBeenCalledWith('test-queue-123', expect.any(Function));
    });

    it('should handle RabbitMQ errors during subscription', async () => {
      // Arrange
      mockChannel.assertQueue.mockRejectedValue(new Error('Queue creation failed'));

      // Act & Assert
      const messageHandler = jest.fn();
      await expect(manager.subscribe('test.topic', messageHandler)).rejects.toThrow('Queue creation failed');
    });
  });

  describe('unsubscribe', () => {
    it('should clean up subscription correctly', async () => {
      // Arrange
      const subscription = { queue: 'test-queue', consumerTag: 'test-consumer' };

      // Act
      await manager.unsubscribe(subscription, 'test.topic');

      // Assert
      expect(mockChannel.cancel).toHaveBeenCalledWith('test-consumer');
      expect(mockChannel.unbindQueue).toHaveBeenCalledWith('test-queue', 'test-exchange', 'test.topic');
      // Note: deleteQueue is not called because we rely on autoDelete behavior
    });

    it('should handle errors during cleanup gracefully', async () => {
      // Arrange
      mockChannel.cancel.mockRejectedValue(new Error('Cancel failed'));
      const subscription = { queue: 'test-queue', consumerTag: 'test-consumer' };

      // Act & Assert
      await expect(manager.unsubscribe(subscription, 'test.topic')).rejects.toThrow('Cancel failed');
    });
  });

  describe('cleanupSubscriptions', () => {
    it('should clean up multiple subscriptions', async () => {
      // Arrange
      const subscriptions = new Map([
        ['topic1', { queue: 'queue1', consumerTag: 'consumer1' }],
        ['topic2', { queue: 'queue2', consumerTag: 'consumer2' }],
      ]);

      // Act
      await manager.cleanupSubscriptions(subscriptions);

      // Assert
      expect(mockChannel.cancel).toHaveBeenCalledTimes(2);
      expect(mockChannel.cancel).toHaveBeenCalledWith('consumer1');
      expect(mockChannel.cancel).toHaveBeenCalledWith('consumer2');

      expect(mockChannel.unbindQueue).toHaveBeenCalledTimes(2);
      // Note: deleteQueue is not called because we rely on autoDelete behavior
    });

    it('should continue cleanup even if individual subscriptions fail', async () => {
      // Arrange
      const subscriptions = new Map([
        ['topic1', { queue: 'queue1', consumerTag: 'consumer1' }],
        ['topic2', { queue: 'queue2', consumerTag: 'consumer2' }],
      ]);

      // Make first subscription fail
      mockChannel.cancel.mockImplementation((consumerTag: string) => {
        if (consumerTag === 'consumer1') {
          throw new Error('Cancel failed');
        }
        return Promise.resolve();
      });


      // Act
      await manager.cleanupSubscriptions(subscriptions);

      // Assert
      // Should still try to clean up the second subscription
      expect(mockChannel.cancel).toHaveBeenCalledWith('consumer2');

    });
  });

  describe('publish', () => {
    it('should publish message to exchange correctly', async () => {
      // Arrange
      const routingKey = 'test.topic';
      const payload = { message: 'hello', data: { test: true } };

      // Act
      await manager.publish(routingKey, payload);

      // Assert
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'test.topic',
        Buffer.from(JSON.stringify(payload))
      );
    });

    it('should handle complex payload objects', async () => {
      // Arrange
      const complexPayload = {
        user: 'john',
        timestamp: new Date().toISOString(),
        data: { nested: { values: [1, 2, 3] } },
        metadata: null
      };

      // Act
      await manager.publish('complex.route', complexPayload);

      // Assert
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'complex.route',
        Buffer.from(JSON.stringify(complexPayload))
      );
    });

    it('should handle publish errors from channel', async () => {
      // Arrange
      mockChannel.publish.mockImplementation(() => {
        throw new Error('Channel publish failed');
      });

      // Act & Assert
      await expect(manager.publish('test.topic', { msg: 'test' }))
        .rejects.toThrow('Channel publish failed');
    });
  });

});
