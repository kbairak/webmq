"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
const amqplib_1 = __importDefault(require("amqplib"));
// Correctly mock the amqplib module structure
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
jest.mock('amqplib', () => ({
    connect: jest.fn().mockResolvedValue(mockConnection),
}));
// Mock the ws library
jest.mock('ws');
describe('WebMQBackend', () => {
    let backend;
    let mockWSS;
    let mockWS;
    beforeEach(() => {
        // Clear all mocks before each test
        jest.clearAllMocks();
        // Setup ws mock
        mockWS = {
            on: jest.fn(),
            send: jest.fn(),
        };
        mockWSS = {
            on: jest.fn(),
        };
        const WebSocket = require('ws');
        WebSocket.Server.mockReturnValue(mockWSS);
        // Re-mock amqplib connect for each test to have a clean slate
        amqplib_1.default.connect.mockClear().mockResolvedValue(mockConnection);
        mockConnection.createChannel.mockClear().mockResolvedValue(mockChannel);
    });
    const getWSSConnectionCallback = () => {
        const onConnectionCall = mockWSS.on.mock.calls.find((call) => call[0] === 'connection');
        return onConnectionCall ? onConnectionCall[1] : null;
    };
    const getWSMessageCallback = () => {
        const onMessageCall = mockWS.on.mock.calls.find((call) => call[0] === 'message');
        return onMessageCall ? onMessageCall[1] : null;
    };
    it('should start, connect to RabbitMQ, and set up WebSocket server', async () => {
        backend = new index_1.WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
        await backend.start(8080);
        expect(amqplib_1.default.connect).toHaveBeenCalledWith('amqp://localhost');
        expect(mockConnection.createChannel).toHaveBeenCalled();
        expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', { durable: false });
        expect(require('ws').Server).toHaveBeenCalledWith({ port: 8080 });
        expect(mockWSS.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });
    it('should handle a listen message correctly', async () => {
        backend = new index_1.WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
        await backend.start(8080);
        const onConnection = getWSSConnectionCallback();
        onConnection(mockWS);
        const onMessage = getWSMessageCallback();
        const listenMessage = { action: 'listen', bindingKey: 'test.key' };
        await onMessage(JSON.stringify(listenMessage));
        expect(mockChannel.assertQueue).toHaveBeenCalledWith('', { exclusive: true, autoDelete: true });
        expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue', 'test-exchange', 'test.key');
        expect(mockChannel.consume).toHaveBeenCalledWith('test-queue', expect.any(Function));
    });
    it('should handle an emit message correctly', async () => {
        backend = new index_1.WebMQBackend({ rabbitmqUrl: 'amqp://localhost', exchangeName: 'test-exchange' });
        await backend.start(8080);
        const onConnection = getWSSConnectionCallback();
        onConnection(mockWS);
        const onMessage = getWSMessageCallback();
        const emitMessage = { action: 'emit', routingKey: 'test.route', payload: { data: 'test' } };
        await onMessage(JSON.stringify(emitMessage));
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
        onConnection(mockWS);
        const onMessage = getWSMessageCallback();
        const emitMessage = { action: 'emit', routingKey: 'test.route', payload: {} };
        await onMessage(JSON.stringify(emitMessage));
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
        onConnection(mockWS);
        const onMessage = getWSMessageCallback();
        const emitMessage = { action: 'emit', routingKey: 'test.route', payload: {} };
        await onMessage(JSON.stringify(emitMessage));
        expect(hook).toHaveBeenCalled();
        expect(mockChannel.publish).not.toHaveBeenCalled();
        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', message: 'Permission Denied' }));
    });
});
