import { WebMQBackend, ClientMessage, Hook } from './index';
import amqplib from 'amqplib';
import { WebSocket, WebSocketServer } from 'ws'; // Import WebSocket and WebSocketServer

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
const { mockConnection, mockChannel } = require('amqplib');

describe('WebMQBackend', () => {
  let backend: WebMQBackend;
  // Access the mocked WebSocket and WebSocketServer directly from the module
  const { WebSocket: MockWebSocket, WebSocketServer: MockWebSocketServer } = require('ws');

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Setup ws mock instances
    const mockWSSInstance = { on: jest.fn() } as unknown as jest.Mocked<WebSocketServer>;
    const mockWSInstance = { on: jest.fn(), send: jest.fn() } as unknown as jest.Mocked<WebSocket>;

    // Set the mock implementations for WebSocket and WebSocketServer
    (MockWebSocket as jest.Mock).mockImplementation(() => mockWSInstance);
    (MockWebSocketServer as jest.Mock).mockImplementation(() => mockWSSInstance);

    // Re-mock amqplib connect for each test to have a clean slate
    (amqplib.connect as jest.Mock).mockClear().mockResolvedValue(mockConnection);
    (mockConnection.createChannel as jest.Mock).mockClear().mockResolvedValue(mockChannel);
  });

  const getWSSConnectionCallback = () => {
    // Access the mockWSSInstance from the mocked WebSocketServer
    const mockWSSInstance = (MockWebSocketServer as jest.Mock).mock.results[0]?.value;
    if (!mockWSSInstance) throw new Error("mockWSSInstance not found");
    const onConnectionCall = (mockWSSInstance.on as jest.Mock).mock.calls.find((call: any) => call[0] === 'connection');
    return onConnectionCall ? onConnectionCall[1] : null;
  };

  const getWSMessageCallback = () => {
    // Access the mockWSInstance from the mocked WebSocket
    const mockWSInstance = (MockWebSocket as jest.Mock).mock.results[0]?.value;
    if (!mockWSInstance) throw new Error("mockWSInstance not found");
    const onMessageCall = (mockWSInstance.on as jest.Mock).mock.calls.find((call: any) => call[0] === 'message');
    return onMessageCall ? onMessageCall[1] : null;
  };

  it('should start, connect to RabbitMQ, and set up WebSocket server', async () => {
    backend = new WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
    await backend.start(8080);

    expect(amqplib.connect).toHaveBeenCalledWith('amqp://localhost');
    expect(mockConnection.createChannel).toHaveBeenCalled();
    expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', { durable: false });
    expect(require('ws').Server).toHaveBeenCalledWith({ port: 8080 });
    expect(mockWSS.on).toHaveBeenCalledWith('connection', expect.any(Function));
  });

  it('should handle a listen message correctly', async () => {
    backend = new WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
    await backend.start(8080);

    const onConnection = getWSSConnectionCallback();
    onConnection(mockWS);

    const onMessage = getWSMessageCallback();
    const listenMessage: ClientMessage = { action: 'listen', bindingKey: 'test.key' };
    await onMessage(JSON.stringify(listenMessage));

    expect(mockChannel.assertQueue).toHaveBeenCalledWith('', { exclusive: true, autoDelete: true });
    expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue', 'test-exchange', 'test.key');
    expect(mockChannel.consume).toHaveBeenCalledWith('test-queue', expect.any(Function));
  });

  it('should handle an emit message correctly', async () => {
    backend = new WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
    await backend.start(8080);

    const onConnection = getWSSConnectionCallback();
    onConnection(mockWS);

    const onMessage = getWSMessageCallback();
    const emitMessage: ClientMessage = { action: 'emit', routingKey: 'test.route', payload: { data: 'test' } };
    await onMessage(JSON.stringify(emitMessage));

    expect(mockChannel.publish).toHaveBeenCalledWith(
      'test-exchange',
      'test.route',
      Buffer.from(JSON.stringify({ data: 'test' }))
    );
  });

  it('should execute hooks before processing a message', async () => {
    const hook: Hook = jest.fn(async (ctx, msg, next) => {
      ctx.user = { id: 'test-user' };
      await next();
    });

    backend = new WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange', hooks: { onEmit: [hook] } });
    await backend.start(8080);

    const onConnection = getWSSConnectionCallback();
    onConnection(mockWS);

    const onMessage = getWSMessageCallback();
    const emitMessage: ClientMessage = { action: 'emit', routingKey: 'test.route', payload: {} };
    await onMessage(JSON.stringify(emitMessage));

    expect(hook).toHaveBeenCalled();
    expect(mockChannel.publish).toHaveBeenCalled(); // Ensure the chain continued
  });

  it('should stop processing if a hook throws an error', async () => {
    const hook: Hook = jest.fn(async (ctx, msg, next) => {
      throw new Error('Permission Denied');
    });

    backend = new WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange', hooks: { onEmit: [hook] } });
    await backend.start(8080);

    const onConnection = getWSSConnectionCallback();
    onConnection(mockWS);

    const onMessage = getWSMessageCallback();
    const emitMessage: ClientMessage = { action: 'emit', routingKey: 'test.route', payload: {} };
    await onMessage(JSON.stringify(emitMessage));

    expect(hook).toHaveBeenCalled();
    expect(mockChannel.publish).not.toHaveBeenCalled();
    expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Permission Denied' }));
  });
});
