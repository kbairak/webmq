import {
  WebMQServer,
  ClientMessage,
} from './index';
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

describe('WebMQServer Lifecycle', () => {
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
      on: jest.fn(), // Add event listener mock
    };

    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
      on: jest.fn(), // Add event listener mock
    };

    // Mock amqplib.connect
    (amqplib.connect as jest.Mock).mockResolvedValue(mockConnection);

    server = new WebMQServer('amqp://localhost', 'test-exchange');
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
    expect(mockChannel.assertExchange).toHaveBeenCalledWith(
      'test-exchange',
      'topic',
      { durable: true }
    );
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
    const connectionHandler = mockWSS.on.mock.calls.find(
      (call: any) => call[0] === 'connection'
    )?.[1];
    if (connectionHandler) {
      connectionHandler(mockWS);
    }

    // Assert
    expect(mockWS.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockWS.on).toHaveBeenCalledWith('close', expect.any(Function));
  });
});