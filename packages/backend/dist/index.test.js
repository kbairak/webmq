"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
const ws_1 = require("ws"); // Import WebSocket and WebSocketServer
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mockConnection, mockChannel } = require('amqplib');
// --- Integration Tests with Mocked Abstractions ---
describe('WebMQBackend Integration (Mocked Abstractions)', () => {
    let backend;
    let mockConnectionManager;
    let mockSubscriptionManager;
    let mockWS;
    let mockConnection;
    let eventLog;
    beforeEach(() => {
        jest.clearAllMocks();
        eventLog = [];
        mockWS = {
            on: jest.fn(),
            send: jest.fn(),
            close: jest.fn(),
        };
        mockConnection = {
            ws: mockWS,
            subscriptions: new Map(),
            context: { ws: mockWS, id: 'test-connection-id' }
        };
        // Set up standard mock returns
        mockConnectionManager = {
            createConnection: jest.fn(),
            getConnection: jest.fn(),
            removeConnection: jest.fn(),
            getAllConnections: jest.fn(),
            getConnectionIds: jest.fn(),
            size: jest.fn(),
        };
        mockConnectionManager.createConnection.mockReturnValue('test-connection-id');
        mockConnectionManager.getConnection.mockReturnValue(mockConnection);
        mockConnectionManager.removeConnection.mockReturnValue(true);
        mockSubscriptionManager = {
            subscribe: jest.fn(),
            unsubscribe: jest.fn(),
            cleanupSubscriptions: jest.fn(),
            createConsumer: jest.fn(),
            publish: jest.fn(),
        };
        mockSubscriptionManager.subscribe.mockResolvedValue({
            queue: 'test-queue',
            consumerTag: 'test-consumer'
        });
        // Mock the backend to use our mocked managers
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange'
        });
        // Replace the managers with our mocks (this requires exposing them or using dependency injection)
        backend.connectionManager = mockConnectionManager;
        backend.subscriptionManager = mockSubscriptionManager;
        backend.channel = {}; // Mock channel exists
        // Set up event logging
        const events = ['client.connected', 'client.disconnected', 'message.received', 'message.processed', 'subscription.created', 'subscription.removed', 'error'];
        events.forEach(eventName => {
            backend.on(eventName, (data) => {
                eventLog.push({ event: eventName, data });
            });
        });
    });
    describe('message processing flow', () => {
        it('should handle emit message with mocked abstractions', async () => {
            // Arrange
            const emitMessage = {
                action: 'emit',
                routingKey: 'test.route',
                payload: { data: 'test' }
            };
            // Act
            await backend.processMessage('test-connection-id', emitMessage);
            // Assert
            expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('test-connection-id');
            expect(mockSubscriptionManager.publish).toHaveBeenCalledWith('test.route', { data: 'test' });
        });
        it('should handle listen message with mocked abstractions', async () => {
            // Arrange
            const listenMessage = {
                action: 'listen',
                bindingKey: 'test.topic'
            };
            // Act
            await backend.processMessage('test-connection-id', listenMessage);
            // Assert
            expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('test-connection-id');
            expect(mockSubscriptionManager.subscribe).toHaveBeenCalledWith('test.topic');
            expect(mockSubscriptionManager.createConsumer).toHaveBeenCalledWith({ queue: 'test-queue', consumerTag: 'test-consumer' }, expect.any(Function));
            expect(mockConnection.subscriptions.has('test.topic')).toBe(true);
            // Check subscription.created event (this is emitted from executeAction)
            const subscriptionEvent = eventLog.find(e => e.event === 'subscription.created');
            expect(subscriptionEvent).toBeDefined();
            expect(subscriptionEvent.data.connectionId).toBe('test-connection-id');
            expect(subscriptionEvent.data.bindingKey).toBe('test.topic');
            expect(subscriptionEvent.data.queue).toBe('test-queue');
        });
        it('should handle unlisten message with mocked abstractions', async () => {
            // Arrange
            const subscription = { queue: 'test-queue', consumerTag: 'test-consumer' };
            mockConnection.subscriptions.set('test.topic', subscription);
            const unlistenMessage = {
                action: 'unlisten',
                bindingKey: 'test.topic'
            };
            // Act
            await backend.processMessage('test-connection-id', unlistenMessage);
            // Assert
            expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('test-connection-id');
            expect(mockSubscriptionManager.unsubscribe).toHaveBeenCalledWith(subscription, 'test.topic');
            expect(mockConnection.subscriptions.has('test.topic')).toBe(false);
            // Check subscription.removed event (this is emitted from executeAction)
            const subscriptionRemovedEvent = eventLog.find(e => e.event === 'subscription.removed');
            expect(subscriptionRemovedEvent).toBeDefined();
            expect(subscriptionRemovedEvent.data.connectionId).toBe('test-connection-id');
            expect(subscriptionRemovedEvent.data.bindingKey).toBe('test.topic');
        });
    });
    describe('connection lifecycle with mocked abstractions', () => {
        it('should handle connection cleanup', async () => {
            // Arrange
            const subscription = { queue: 'test-queue', consumerTag: 'test-consumer' };
            mockConnection.subscriptions.set('test.topic', subscription);
            // Act
            await backend.cleanup('test-connection-id');
            // Assert
            expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('test-connection-id');
            expect(mockSubscriptionManager.cleanupSubscriptions).toHaveBeenCalledWith(mockConnection.subscriptions);
            expect(mockConnectionManager.removeConnection).toHaveBeenCalledWith('test-connection-id');
            // Check client.disconnected event
            const disconnectedEvent = eventLog.find(e => e.event === 'client.disconnected');
            expect(disconnectedEvent).toBeDefined();
            expect(disconnectedEvent.data.connectionId).toBe('test-connection-id');
        });
        it('should handle missing connection during cleanup', async () => {
            // Arrange
            mockConnectionManager.getConnection.mockReturnValue(undefined);
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            // Act
            await backend.cleanup('invalid-connection-id');
            // Assert
            expect(consoleSpy).toHaveBeenCalledWith('Connection invalid-connection-id not found during cleanup');
            expect(mockSubscriptionManager.cleanupSubscriptions).not.toHaveBeenCalled();
            expect(mockConnectionManager.removeConnection).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });
    describe('error handling with mocked abstractions', () => {
        it('should handle missing connection during message processing', async () => {
            // Arrange
            mockConnectionManager.getConnection.mockReturnValue(undefined);
            const message = { action: 'emit', routingKey: 'test', payload: {} };
            // Act & Assert
            await expect(backend.processMessage('invalid-id', message))
                .rejects.toThrow('Connection invalid-id not found');
        });
        it('should handle subscription manager errors', async () => {
            // Arrange
            const listenMessage = {
                action: 'listen',
                bindingKey: 'test.topic'
            };
            mockSubscriptionManager.subscribe.mockRejectedValue(new Error('Subscription failed'));
            // Act & Assert
            await expect(backend.processMessage('test-connection-id', listenMessage))
                .rejects.toThrow('Subscription failed');
            expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('test-connection-id');
            expect(mockSubscriptionManager.subscribe).toHaveBeenCalledWith('test.topic');
        });
    });
});
// --- Additional Coverage Tests ---
describe('WebMQBackend start method', () => {
    let backend;
    let mockConnection;
    let mockChannel;
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
        amqplib_1.default.connect.mockResolvedValue(mockConnection);
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange',
        });
    });
    it('should initialize RabbitMQ connection and WebSocket server', async () => {
        // Arrange
        const mockWSS = {
            on: jest.fn(),
        };
        ws_1.WebSocketServer.mockImplementation(() => mockWSS);
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
        // Act
        await backend.start(8080);
        // Assert
        expect(amqplib_1.default.connect).toHaveBeenCalledWith('amqp://localhost');
        expect(mockConnection.createChannel).toHaveBeenCalled();
        expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', { durable: false });
        expect(ws_1.WebSocketServer).toHaveBeenCalledWith({ port: 8080 });
        expect(mockWSS.on).toHaveBeenCalledWith('connection', expect.any(Function));
        expect(consoleSpy).toHaveBeenCalledWith('Starting WebMQ Backend...');
        expect(consoleSpy).toHaveBeenCalledWith('RabbitMQ connection and shared channel established');
        expect(consoleSpy).toHaveBeenCalledWith('WebMQ Backend started on ws://localhost:8080');
        consoleSpy.mockRestore();
    });
    it('should handle WebSocket connections', async () => {
        // Arrange
        const mockWS = {
            on: jest.fn(),
        };
        const mockWSS = {
            on: jest.fn(),
        };
        ws_1.WebSocketServer.mockImplementation(() => mockWSS);
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
        // Act
        await backend.start(8080);
        const connectionHandler = mockWSS.on.mock.calls.find((call) => call[0] === 'connection')?.[1];
        if (connectionHandler) {
            connectionHandler(mockWS);
        }
        // Assert
        expect(mockWS.on).toHaveBeenCalledWith('message', expect.any(Function));
        expect(mockWS.on).toHaveBeenCalledWith('close', expect.any(Function));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/Client .* connected\./));
        consoleSpy.mockRestore();
    });
    it('should throw error if channel not established during connection', async () => {
        // Arrange
        const mockWS = {};
        const mockWSS = {
            on: jest.fn(),
        };
        ws_1.WebSocketServer.mockImplementation(() => mockWSS);
        // Act
        await backend.start(8080);
        // Manually clear the channel to simulate error condition
        backend.channel = null;
        const connectionHandler = mockWSS.on.mock.calls.find((call) => call[0] === 'connection')?.[1];
        // Assert
        expect(() => {
            if (connectionHandler) {
                connectionHandler(mockWS);
            }
        }).toThrow('Shared channel not established.');
    });
});
describe('Hook system', () => {
    let backend;
    let mockConnectionManager;
    let mockSubscriptionManager;
    let mockConnection;
    let hookExecutionLog;
    beforeEach(() => {
        jest.clearAllMocks();
        hookExecutionLog = [];
        mockConnection = {
            ws: {},
            subscriptions: new Map(),
            context: { ws: {}, id: 'test-connection-id' }
        };
        mockConnectionManager = {
            createConnection: jest.fn().mockReturnValue('test-connection-id'),
            getConnection: jest.fn().mockReturnValue(mockConnection),
            removeConnection: jest.fn().mockReturnValue(true),
            getAllConnections: jest.fn(),
            getConnectionIds: jest.fn(),
            size: jest.fn(),
        };
        mockSubscriptionManager = {
            subscribe: jest.fn().mockResolvedValue({ queue: 'test-queue', consumerTag: 'test-consumer' }),
            unsubscribe: jest.fn().mockResolvedValue(undefined),
            cleanupSubscriptions: jest.fn().mockResolvedValue(undefined),
            createConsumer: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn().mockResolvedValue(undefined),
        };
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
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange',
            hooks: {
                pre: [preHook],
                onListen: [listenHook],
            }
        });
        backend.connectionManager = mockConnectionManager;
        backend.subscriptionManager = mockSubscriptionManager;
        backend.channel = {};
        const message = {
            action: 'listen',
            bindingKey: 'test.topic'
        };
        // Act
        await backend.processMessage('test-connection-id', message);
        // Assert
        expect(hookExecutionLog).toEqual(['pre', 'listen']);
        expect(preHook).toHaveBeenCalledWith(mockConnection.context, message, expect.any(Function));
        expect(listenHook).toHaveBeenCalledWith(mockConnection.context, message, expect.any(Function));
    });
    it('should execute hooks in correct order for emit action', async () => {
        // Arrange
        const preHook = jest.fn(async (ctx, msg, next) => {
            hookExecutionLog.push('pre');
            await next();
        });
        const emitHook = jest.fn(async (ctx, msg, next) => {
            hookExecutionLog.push('emit');
            await next();
        });
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange',
            hooks: {
                pre: [preHook],
                onEmit: [emitHook],
            }
        });
        backend.connectionManager = mockConnectionManager;
        backend.subscriptionManager = mockSubscriptionManager;
        backend.channel = {};
        const message = {
            action: 'emit',
            routingKey: 'test.route',
            payload: { data: 'test' }
        };
        // Act
        await backend.processMessage('test-connection-id', message);
        // Assert
        expect(hookExecutionLog).toEqual(['pre', 'emit']);
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
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange',
            hooks: {
                pre: [preHook],
                onUnlisten: [unlistenHook],
            }
        });
        backend.connectionManager = mockConnectionManager;
        backend.subscriptionManager = mockSubscriptionManager;
        backend.channel = {};
        // Set up existing subscription
        mockConnection.subscriptions.set('test.topic', { queue: 'test-queue', consumerTag: 'test-consumer' });
        const message = {
            action: 'unlisten',
            bindingKey: 'test.topic'
        };
        // Act
        await backend.processMessage('test-connection-id', message);
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
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange',
            hooks: {
                pre: [contextModifyingHook],
            }
        });
        backend.connectionManager = mockConnectionManager;
        backend.subscriptionManager = mockSubscriptionManager;
        backend.channel = {};
        const message = {
            action: 'emit',
            routingKey: 'test.route',
            payload: { data: 'test' }
        };
        // Act
        await backend.processMessage('test-connection-id', message);
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
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange',
            hooks: {
                pre: [preHook],
            }
        });
        backend.connectionManager = mockConnectionManager;
        backend.subscriptionManager = mockSubscriptionManager;
        backend.channel = {};
        // Test the getHooksForAction method with unknown action
        const hooks = backend.getHooksForAction('unknown');
        // Assert
        expect(hooks).toEqual([preHook]);
    });
});
describe('WebSocket message handling', () => {
    let backend;
    let mockConnectionManager;
    let mockSubscriptionManager;
    let mockConnection;
    let mockWS;
    beforeEach(() => {
        jest.clearAllMocks();
        mockWS = {
            on: jest.fn(),
            send: jest.fn(),
            close: jest.fn(),
        };
        mockConnection = {
            ws: mockWS,
            subscriptions: new Map(),
            context: { ws: mockWS, id: 'test-connection-id' }
        };
        mockConnectionManager = {
            createConnection: jest.fn().mockReturnValue('test-connection-id'),
            getConnection: jest.fn().mockReturnValue(mockConnection),
            removeConnection: jest.fn().mockReturnValue(true),
            getAllConnections: jest.fn(),
            getConnectionIds: jest.fn(),
            size: jest.fn(),
        };
        mockSubscriptionManager = {
            subscribe: jest.fn().mockResolvedValue({ queue: 'test-queue', consumerTag: 'test-consumer' }),
            unsubscribe: jest.fn().mockResolvedValue(undefined),
            cleanupSubscriptions: jest.fn().mockResolvedValue(undefined),
            createConsumer: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn().mockResolvedValue(undefined),
        };
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange'
        });
        backend.connectionManager = mockConnectionManager;
        backend.subscriptionManager = mockSubscriptionManager;
        backend.channel = {};
    });
    it('should handle malformed JSON messages', async () => {
        // Arrange
        const mockWSS = { on: jest.fn() };
        ws_1.WebSocketServer.mockImplementation(() => mockWSS);
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        // Add error event listener to prevent unhandled error
        const errorEvents = [];
        backend.on('error', (data) => {
            errorEvents.push(data);
        });
        // Act
        await backend.start(8080);
        const connectionHandler = mockWSS.on.mock.calls.find((call) => call[0] === 'connection')?.[1];
        if (connectionHandler) {
            connectionHandler(mockWS);
        }
        // Get the message handler and simulate malformed JSON
        const messageHandler = mockWS.on.mock.calls.find((call) => call[0] === 'message')?.[1];
        if (messageHandler) {
            await messageHandler.call(mockWS, Buffer.from('invalid json'));
        }
        // Assert
        expect(consoleErrorSpy).toHaveBeenCalledWith('[test-connection-id] Error processing message:', expect.stringContaining('Unexpected token'));
        // Check that WebSocket.send was called with error message
        expect(mockWS.send).toHaveBeenCalledTimes(1);
        const sentData = mockWS.send.mock.calls[0][0];
        const sentMessage = JSON.parse(sentData.toString());
        expect(sentMessage.type).toBe('error');
        expect(sentMessage.message).toContain('Unexpected token');
        // Check that error event was emitted
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0].connectionId).toBe('test-connection-id');
        expect(errorEvents[0].context).toBe('message processing');
        expect(errorEvents[0].error.message).toContain('Unexpected token');
        consoleErrorSpy.mockRestore();
    });
    it('should send messages to WebSocket clients through message handler', async () => {
        // Arrange
        const testPayload = { user: 'john', message: 'hello world' };
        let messageHandlerCallback;
        // Capture the message handler callback when createConsumer is called
        mockSubscriptionManager.createConsumer.mockImplementation(async (subscription, handler) => {
            messageHandlerCallback = handler;
        });
        const message = {
            action: 'listen',
            bindingKey: 'chat.room.1'
        };
        // Act
        await backend.processMessage('test-connection-id', message);
        // Simulate a RabbitMQ message being received
        const mockRabbitMsg = {
            content: Buffer.from(JSON.stringify(testPayload))
        };
        messageHandlerCallback(mockRabbitMsg);
        // Assert
        expect(mockWS.send).toHaveBeenCalledWith(JSON.stringify({
            type: 'message',
            bindingKey: 'chat.room.1',
            payload: testPayload,
        }));
    });
    it('should handle WebSocket close events', async () => {
        // Arrange
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
        // Test the cleanup method directly since that's what the close handler calls
        await backend.cleanup('test-connection-id');
        // Assert
        expect(mockConnectionManager.getConnection).toHaveBeenCalledWith('test-connection-id');
        expect(mockSubscriptionManager.cleanupSubscriptions).toHaveBeenCalledWith(mockConnection.subscriptions);
        expect(mockConnectionManager.removeConnection).toHaveBeenCalledWith('test-connection-id');
        expect(consoleSpy).toHaveBeenCalledWith('Client test-connection-id disconnected. Cleaning up resources.');
        consoleSpy.mockRestore();
    });
    it('should emit events during message processing', async () => {
        // Arrange
        const mockWSS = { on: jest.fn() };
        ws_1.WebSocketServer.mockImplementation(() => mockWSS);
        const eventLog = [];
        // Set up event logging
        const events = ['message.received', 'message.processed', 'error'];
        events.forEach(eventName => {
            backend.on(eventName, (data) => {
                eventLog.push({ event: eventName, data });
            });
        });
        const validMessage = {
            action: 'emit',
            routingKey: 'test.route',
            payload: { data: 'test' }
        };
        // Act
        await backend.start(8080);
        const connectionHandler = mockWSS.on.mock.calls.find((call) => call[0] === 'connection')?.[1];
        if (connectionHandler) {
            connectionHandler(mockWS);
        }
        // Get the message handler and simulate valid message
        const messageHandler = mockWS.on.mock.calls.find((call) => call[0] === 'message')?.[1];
        if (messageHandler) {
            await messageHandler.call(mockWS, Buffer.from(JSON.stringify(validMessage)));
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
    let backend;
    let mockConnectionManager;
    let mockSubscriptionManager;
    let mockConnection;
    beforeEach(() => {
        jest.clearAllMocks();
        mockConnection = {
            ws: {},
            subscriptions: new Map(),
            context: { ws: {}, id: 'test-connection-id' }
        };
        mockConnectionManager = {
            createConnection: jest.fn().mockReturnValue('test-connection-id'),
            getConnection: jest.fn().mockReturnValue(mockConnection),
            removeConnection: jest.fn().mockReturnValue(true),
            getAllConnections: jest.fn(),
            getConnectionIds: jest.fn(),
            size: jest.fn(),
        };
        mockSubscriptionManager = {
            subscribe: jest.fn().mockResolvedValue({ queue: 'test-queue', consumerTag: 'test-consumer' }),
            unsubscribe: jest.fn().mockResolvedValue(undefined),
            cleanupSubscriptions: jest.fn().mockResolvedValue(undefined),
            createConsumer: jest.fn().mockResolvedValue(undefined),
            publish: jest.fn().mockResolvedValue(undefined),
        };
        backend = new index_1.WebMQBackend({
            rabbitmqUrl: 'amqp://localhost',
            exchangeName: 'test-exchange'
        });
        backend.connectionManager = mockConnectionManager;
        backend.subscriptionManager = mockSubscriptionManager;
        backend.channel = {};
    });
    it('should handle missing routingKey in emit', async () => {
        // Arrange
        const message = {
            action: 'emit',
            payload: { data: 'test' }
            // Missing routingKey
        };
        // Act & Assert
        await expect(backend.processMessage('test-connection-id', message))
            .rejects.toThrow('emit requires routingKey and payload');
    });
    it('should handle missing payload in emit', async () => {
        // Arrange
        const message = {
            action: 'emit',
            routingKey: 'test.route'
            // Missing payload
        };
        // Act & Assert
        await expect(backend.processMessage('test-connection-id', message))
            .rejects.toThrow('emit requires routingKey and payload');
    });
    it('should handle missing bindingKey in listen', async () => {
        // Arrange
        const message = {
            action: 'listen'
            // Missing bindingKey
        };
        // Act & Assert
        await expect(backend.processMessage('test-connection-id', message))
            .rejects.toThrow('listen requires a bindingKey');
    });
    it('should handle missing bindingKey in unlisten', async () => {
        // Arrange
        const message = {
            action: 'unlisten'
            // Missing bindingKey
        };
        // Act & Assert
        await expect(backend.processMessage('test-connection-id', message))
            .rejects.toThrow('unlisten requires a bindingKey');
    });
    it('should handle unknown action types', async () => {
        // Arrange
        const message = {
            action: 'unknown-action'
        };
        // Act & Assert
        await expect(backend.processMessage('test-connection-id', message))
            .rejects.toThrow('Unknown action: unknown-action');
    });
    it('should handle already existing subscriptions in listen', async () => {
        // Arrange
        mockConnection.subscriptions.set('test.topic', { queue: 'existing-queue', consumerTag: 'existing-consumer' });
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
        const message = {
            action: 'listen',
            bindingKey: 'test.topic'
        };
        // Act
        await backend.processMessage('test-connection-id', message);
        // Assert
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] Already listening to test.topic');
        expect(mockSubscriptionManager.subscribe).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
    it('should handle non-existent subscription in unlisten', async () => {
        // Arrange
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
        const message = {
            action: 'unlisten',
            bindingKey: 'non-existent-topic'
        };
        // Act
        await backend.processMessage('test-connection-id', message);
        // Assert
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] No subscription found for non-existent-topic');
        expect(mockSubscriptionManager.unsubscribe).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
    it('should handle missing connection or channel in executeAction', async () => {
        // Arrange
        const message = {
            action: 'emit',
            routingKey: 'test.route',
            payload: { data: 'test' }
        };
        // Test with missing subscription manager
        backend.subscriptionManager = null;
        // Act & Assert
        await expect(backend.processMessage('test-connection-id', message))
            .rejects.toThrow('Connection test-connection-id or shared channel not available');
    });
    it('should log action execution steps', async () => {
        // Arrange
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
        const message = {
            action: 'emit',
            routingKey: 'test.route',
            payload: { data: 'test' }
        };
        // Act
        await backend.processMessage('test-connection-id', message);
        // Assert
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] Processing message:', JSON.stringify(message));
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] Executing action: emit');
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] Executing emit action');
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] Emit - routingKey: test.route, payload:', { data: 'test' });
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] Message published successfully');
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] Action emit completed successfully');
        expect(consoleSpy).toHaveBeenCalledWith('[test-connection-id] Message processed successfully');
        consoleSpy.mockRestore();
    });
});
// --- Individual Component Tests ---
describe('ConnectionManager', () => {
    let manager;
    let mockWS;
    beforeEach(() => {
        manager = new index_1.ConnectionManager();
        mockWS = {
            on: jest.fn(),
            send: jest.fn(),
            close: jest.fn(),
        };
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
            expect(connection.ws).toBe(mockWS);
            expect(connection.context.id).toBe(id);
            expect(connection.context.ws).toBe(mockWS);
            expect(connection.subscriptions).toBeInstanceOf(Map);
            expect(connection.subscriptions.size).toBe(0);
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
            expect(connection.context.id).toBe(id);
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
describe('SubscriptionManager', () => {
    let manager;
    let mockChannel;
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
        manager = new index_1.SubscriptionManager(mockChannel, 'test-exchange');
    });
    describe('subscribe', () => {
        it('should create a subscription correctly', async () => {
            // Act
            const subscription = await manager.subscribe('test.topic');
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
            await expect(manager.subscribe('test.topic')).rejects.toThrow('Queue creation failed');
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
            expect(mockChannel.deleteQueue).toHaveBeenCalledWith('test-queue');
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
            expect(mockChannel.deleteQueue).toHaveBeenCalledTimes(2);
        });
        it('should continue cleanup even if individual subscriptions fail', async () => {
            // Arrange
            const subscriptions = new Map([
                ['topic1', { queue: 'queue1', consumerTag: 'consumer1' }],
                ['topic2', { queue: 'queue2', consumerTag: 'consumer2' }],
            ]);
            // Make first subscription fail
            mockChannel.cancel.mockImplementation((consumerTag) => {
                if (consumerTag === 'consumer1') {
                    throw new Error('Cancel failed');
                }
                return Promise.resolve();
            });
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
            // Act
            await manager.cleanupSubscriptions(subscriptions);
            // Assert
            // Should still try to clean up the second subscription
            expect(mockChannel.cancel).toHaveBeenCalledWith('consumer2');
            expect(consoleSpy).toHaveBeenCalledWith('Error cleaning up subscription for topic1:', expect.any(Error));
            consoleSpy.mockRestore();
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
            expect(mockChannel.publish).toHaveBeenCalledWith('test-exchange', 'test.topic', Buffer.from(JSON.stringify(payload)));
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
            expect(mockChannel.publish).toHaveBeenCalledWith('test-exchange', 'complex.route', Buffer.from(JSON.stringify(complexPayload)));
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
    describe('createConsumer', () => {
        it('should recreate consumer with custom handler', async () => {
            // Arrange
            const subscription = { queue: 'test-queue', consumerTag: 'old-consumer' };
            const messageHandler = jest.fn();
            mockChannel.consume.mockResolvedValueOnce({ consumerTag: 'new-consumer' });
            // Act
            await manager.createConsumer(subscription, messageHandler);
            // Assert
            expect(mockChannel.cancel).toHaveBeenCalledWith('old-consumer');
            expect(mockChannel.consume).toHaveBeenCalledWith('test-queue', expect.any(Function));
            expect(subscription.consumerTag).toBe('new-consumer');
        });
        it('should call custom handler and ack message', async () => {
            const subscription = { queue: 'test-queue', consumerTag: 'old-consumer' };
            const messageHandler = jest.fn();
            const mockMessage = { content: Buffer.from('test'), ack: jest.fn() };
            mockChannel.consume.mockImplementation((queue, callback) => {
                // Simulate message received
                callback(mockMessage);
                return Promise.resolve({ consumerTag: 'new-consumer' });
            });
            await manager.createConsumer(subscription, messageHandler);
            expect(messageHandler).toHaveBeenCalledWith(mockMessage);
            expect(mockChannel.ack).toHaveBeenCalledWith(mockMessage);
        });
    });
});
