"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
const amqplib_1 = __importDefault(require("amqplib"));
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
    let backend;
    let mockWSSInstance;
    let mockWSInstance;
    // Access the mocked WebSocket and WebSocketServer directly from the module
    const { WebSocket: MockWebSocket, WebSocketServer: MockWebSocketServer } = require('ws');
    beforeEach(() => {
        // Clear all mocks before each test
        jest.clearAllMocks();
        // Setup ws mock instances
        mockWSSInstance = { on: jest.fn() };
        mockWSInstance = { on: jest.fn(), send: jest.fn() };
        // Set the mock implementations for WebSocket and WebSocketServer
        MockWebSocket.mockImplementation(() => mockWSInstance);
        MockWebSocketServer.mockImplementation(() => mockWSSInstance);
        // Re-mock amqplib connect for each test to have a clean slate
        amqplib_1.default.connect.mockClear().mockResolvedValue(mockConnection);
        mockConnection.createChannel.mockClear().mockResolvedValue(mockChannel);
        // Clear the mock channel calls for each test
        Object.values(mockChannel).forEach((mockFn) => {
            if (typeof mockFn === 'function' && mockFn.mockClear) {
                mockFn.mockClear();
            }
        });
    });
    const getWSSConnectionCallback = () => {
        // Return the connection callback from the mockWSSInstance
        const onConnectionCall = mockWSSInstance.on.mock.calls.find((call) => call[0] === 'connection');
        return onConnectionCall ? onConnectionCall[1] : null;
    };
    it('should start, connect to RabbitMQ, and set up WebSocket server', async () => {
        backend = new index_1.WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
        await backend.start(8080);
        expect(amqplib_1.default.connect).toHaveBeenCalledWith('amqp://localhost');
        expect(mockConnection.createChannel).toHaveBeenCalled();
        expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', { durable: false });
        expect(MockWebSocketServer).toHaveBeenCalledWith({ port: 8080 });
        expect(mockWSSInstance.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });
    it('should handle a listen message correctly', async () => {
        backend = new index_1.WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
        await backend.start(8080);
        const onConnection = getWSSConnectionCallback();
        await onConnection(mockWSInstance); // Wait for connection handling to complete
        // Manually trigger the message event on the mock WebSocket
        const listenMessage = { action: 'listen', bindingKey: 'test.key' };
        const messageCallback = mockWSInstance.on.mock.calls.find((call) => call[0] === 'message')?.[1];
        if (messageCallback) {
            await messageCallback(Buffer.from(JSON.stringify(listenMessage)));
        }
        expect(mockChannel.assertQueue).toHaveBeenCalledWith('', { exclusive: true, autoDelete: true });
        expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue', 'test-exchange', 'test.key');
        expect(mockChannel.consume).toHaveBeenCalledWith('test-queue', expect.any(Function));
    });
    it('should handle an emit message correctly', async () => {
        backend = new index_1.WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
        await backend.start(8080);
        const onConnection = getWSSConnectionCallback();
        await onConnection(mockWSInstance);
        // Manually trigger the message event on the mock WebSocket
        const emitMessage = { action: 'emit', routingKey: 'test.route', payload: { data: 'test' } };
        const messageCallback = mockWSInstance.on.mock.calls.find((call) => call[0] === 'message')?.[1];
        if (messageCallback) {
            await messageCallback(Buffer.from(JSON.stringify(emitMessage)));
        }
        expect(mockChannel.publish).toHaveBeenCalledWith('test-exchange', 'test.route', Buffer.from(JSON.stringify({ data: 'test' })));
    });
    it('should execute hooks before processing a message', async () => {
        const hook = jest.fn(async (ctx, msg, next) => {
            ctx.user = { id: 'test-user' };
            await next();
        });
        backend = new index_1.WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange', hooks: { onEmit: [hook] } });
        await backend.start(8080);
        const onConnection = getWSSConnectionCallback();
        await onConnection(mockWSInstance);
        // Manually trigger the message event on the mock WebSocket
        const emitMessage = { action: 'emit', routingKey: 'test.route', payload: {} };
        const messageCallback = mockWSInstance.on.mock.calls.find((call) => call[0] === 'message')?.[1];
        if (messageCallback) {
            await messageCallback(Buffer.from(JSON.stringify(emitMessage)));
        }
        expect(hook).toHaveBeenCalled();
        expect(mockChannel.publish).toHaveBeenCalled(); // Ensure the chain continued
    });
    it('should stop processing if a hook throws an error', async () => {
        const hook = jest.fn(async (ctx, msg, next) => {
            throw new Error('Permission Denied');
        });
        backend = new index_1.WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange', hooks: { onEmit: [hook] } });
        await backend.start(8080);
        const onConnection = getWSSConnectionCallback();
        await onConnection(mockWSInstance);
        // Manually trigger the message event on the mock WebSocket
        const emitMessage = { action: 'emit', routingKey: 'test.route', payload: {} };
        const messageCallback = mockWSInstance.on.mock.calls.find((call) => call[0] === 'message')?.[1];
        if (messageCallback) {
            await messageCallback(Buffer.from(JSON.stringify(emitMessage)));
        }
        expect(hook).toHaveBeenCalled();
        expect(mockChannel.publish).not.toHaveBeenCalled();
        expect(mockWSInstance.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Permission Denied' }));
    });
});
