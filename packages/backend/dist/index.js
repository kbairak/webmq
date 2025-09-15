"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebMQBackend = exports.SubscriptionManager = exports.ConnectionManager = void 0;
const ws_1 = require("ws");
const amqplib_1 = __importDefault(require("amqplib"));
const crypto_1 = __importDefault(require("crypto"));
const events_1 = require("events");
// --- Connection Management ---
class ConnectionManager {
    constructor() {
        this.connections = new Map();
    }
    createConnection(ws) {
        const id = crypto_1.default.randomUUID();
        const context = { ws, id };
        const subscriptions = new Map();
        this.connections.set(id, { ws, subscriptions, context });
        return id;
    }
    getConnection(id) {
        return this.connections.get(id);
    }
    removeConnection(id) {
        return this.connections.delete(id);
    }
    getAllConnections() {
        return Array.from(this.connections.values());
    }
    getConnectionIds() {
        return Array.from(this.connections.keys());
    }
    size() {
        return this.connections.size;
    }
}
exports.ConnectionManager = ConnectionManager;
// --- Subscription Management ---
class SubscriptionManager {
    constructor(channel, exchangeName) {
        this.channel = channel;
        this.exchangeName = exchangeName;
    }
    async subscribe(bindingKey) {
        const { queue } = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true
        });
        await this.channel.bindQueue(queue, this.exchangeName, bindingKey);
        const { consumerTag } = await this.channel.consume(queue, (msg) => {
            if (msg) {
                // This callback will be overridden by the caller
                this.channel.ack(msg);
            }
        });
        return { queue, consumerTag };
    }
    async unsubscribe(subscription, bindingKey) {
        await this.channel.cancel(subscription.consumerTag);
        await this.channel.unbindQueue(subscription.queue, this.exchangeName, bindingKey);
        await this.channel.deleteQueue(subscription.queue);
    }
    async publish(routingKey, payload) {
        this.channel.publish(this.exchangeName, routingKey, Buffer.from(JSON.stringify(payload)));
    }
    async cleanupSubscriptions(subscriptions) {
        for (const [bindingKey, subscription] of subscriptions.entries()) {
            try {
                await this.unsubscribe(subscription, bindingKey);
            }
            catch (err) {
                console.error(`Error cleaning up subscription for ${bindingKey}:`, err);
            }
        }
    }
    async createConsumer(subscription, messageHandler) {
        // Cancel existing consumer and create new one with custom handler
        await this.channel.cancel(subscription.consumerTag);
        const { consumerTag } = await this.channel.consume(subscription.queue, (msg) => {
            if (msg) {
                messageHandler(msg);
                this.channel.ack(msg);
            }
        });
        // Update the subscription with new consumer tag
        subscription.consumerTag = consumerTag;
    }
}
exports.SubscriptionManager = SubscriptionManager;
// --- Backend Implementation ---
/**
 * WebMQBackend emits the following events:
 *
 * - 'client.connected': { connectionId: string }
 * - 'client.disconnected': { connectionId: string }
 * - 'message.received': { connectionId: string; message: ClientMessage }
 * - 'message.processed': { connectionId: string; message: ClientMessage }
 * - 'subscription.created': { connectionId: string; bindingKey: string; queue: string }
 * - 'subscription.removed': { connectionId: string; bindingKey: string }
 * - 'error': { connectionId?: string; error: Error; context?: string }
 */
class WebMQBackend extends events_1.EventEmitter {
    constructor(options) {
        super();
        this.connection = null;
        this.channel = null;
        this.connectionManager = new ConnectionManager();
        this.subscriptionManager = null;
        this.rabbitmqUrl = options.rabbitmqUrl;
        this.exchangeName = options.exchangeName;
        this.exchangeDurable = options.exchangeDurable ?? false; // Default to false for performance
        this.hooks = {
            pre: options.hooks?.pre || [],
            onListen: options.hooks?.onListen || [],
            onEmit: options.hooks?.onEmit || [],
            onUnlisten: options.hooks?.onUnlisten || [],
        };
    }
    async start(port) {
        console.log('Starting WebMQ Backend...');
        // Establish RabbitMQ connection and shared channel
        this.connection = await amqplib_1.default.connect(this.rabbitmqUrl);
        this.channel = await this.connection.createChannel();
        await this.channel.assertExchange(this.exchangeName, 'topic', { durable: this.exchangeDurable });
        // Initialize subscription manager
        this.subscriptionManager = new SubscriptionManager(this.channel, this.exchangeName);
        console.log('RabbitMQ connection and shared channel established');
        const wss = new ws_1.WebSocketServer({ port });
        wss.on('connection', (ws) => {
            if (!this.channel) {
                throw new Error('Shared channel not established.');
            }
            const id = this.connectionManager.createConnection(ws);
            console.log(`Client ${id} connected.`);
            this.emit('client.connected', { connectionId: id });
            // Set up WebSocket event handlers
            ws.on('message', async (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.emit('message.received', { connectionId: id, message });
                    await this.processMessage(id, message);
                    this.emit('message.processed', { connectionId: id, message });
                }
                catch (error) {
                    console.error(`[${id}] Error processing message:`, error.message);
                    this.emit('error', { connectionId: id, error, context: 'message processing' });
                    ws.send(JSON.stringify({ type: 'error', message: error.message }));
                }
            });
            ws.on('close', async () => {
                await this.cleanup(id);
            });
        });
        console.log(`WebMQ Backend started on ws://localhost:${port}`);
    }
    async processMessage(connectionId, message) {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection) {
            throw new Error(`Connection ${connectionId} not found`);
        }
        console.log(`[${connectionId}] Processing message:`, JSON.stringify(message));
        const hooks = this.getHooksForAction(message.action);
        const run = async (index) => {
            if (index >= hooks.length) {
                console.log(`[${connectionId}] Executing action: ${message.action}`);
                return this.executeAction(connectionId, message);
            }
            console.log(`[${connectionId}] Running hook ${index}/${hooks.length}`);
            await hooks[index](connection.context, message, () => run(index + 1));
        };
        try {
            await run(0);
            console.log(`[${connectionId}] Message processed successfully`);
        }
        catch (error) {
            console.error(`[${connectionId}] Error in processMessage:`, error.message);
            console.error(`[${connectionId}] Stack trace:`, error.stack);
            throw error;
        }
    }
    async executeAction(connectionId, message) {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection || !this.channel || !this.subscriptionManager) {
            throw new Error(`Connection ${connectionId} or shared channel not available`);
        }
        console.log(`[${connectionId}] Executing ${message.action} action`);
        try {
            switch (message.action) {
                case 'emit':
                    console.log(`[${connectionId}] Emit - routingKey: ${message.routingKey}, payload:`, message.payload);
                    if (!message.routingKey || !message.payload) {
                        throw new Error('emit requires routingKey and payload');
                    }
                    await this.subscriptionManager.publish(message.routingKey, message.payload);
                    console.log(`[${connectionId}] Message published successfully`);
                    break;
                case 'listen':
                    console.log(`[${connectionId}] Listen - bindingKey: ${message.bindingKey}`);
                    if (!message.bindingKey)
                        throw new Error('listen requires a bindingKey');
                    if (connection.subscriptions.has(message.bindingKey)) {
                        console.log(`[${connectionId}] Already listening to ${message.bindingKey}`);
                        return; // Already listening
                    }
                    const subscription = await this.subscriptionManager.subscribe(message.bindingKey);
                    console.log(`[${connectionId}] Queue created: ${subscription.queue}`);
                    // Set up custom message handler
                    await this.subscriptionManager.createConsumer(subscription, (msg) => {
                        console.log(`[${connectionId}] Received message from RabbitMQ:`, msg.content.toString());
                        connection.ws.send(JSON.stringify({
                            type: 'message',
                            bindingKey: message.bindingKey,
                            payload: JSON.parse(msg.content.toString()),
                        }));
                    });
                    connection.subscriptions.set(message.bindingKey, subscription);
                    this.emit('subscription.created', {
                        connectionId,
                        bindingKey: message.bindingKey,
                        queue: subscription.queue
                    });
                    console.log(`[${connectionId}] Consumer set up with tag: ${subscription.consumerTag}`);
                    break;
                case 'unlisten':
                    console.log(`[${connectionId}] Unlisten - bindingKey: ${message.bindingKey}`);
                    if (!message.bindingKey)
                        throw new Error('unlisten requires a bindingKey');
                    const sub = connection.subscriptions.get(message.bindingKey);
                    if (sub) {
                        await this.subscriptionManager.unsubscribe(sub, message.bindingKey);
                        connection.subscriptions.delete(message.bindingKey);
                        this.emit('subscription.removed', { connectionId, bindingKey: message.bindingKey });
                        console.log(`[${connectionId}] Unsubscribed from ${message.bindingKey}`);
                    }
                    else {
                        console.log(`[${connectionId}] No subscription found for ${message.bindingKey}`);
                    }
                    break;
                default:
                    throw new Error(`Unknown action: ${message.action}`);
            }
            console.log(`[${connectionId}] Action ${message.action} completed successfully`);
        }
        catch (error) {
            console.error(`[${connectionId}] Error in executeAction(${message.action}):`, error.message);
            console.error(`[${connectionId}] Stack trace:`, error.stack);
            throw error;
        }
    }
    async cleanup(connectionId) {
        const connection = this.connectionManager.getConnection(connectionId);
        if (!connection) {
            console.warn(`Connection ${connectionId} not found during cleanup`);
            return;
        }
        console.log(`Client ${connectionId} disconnected. Cleaning up resources.`);
        if (this.subscriptionManager) {
            await this.subscriptionManager.cleanupSubscriptions(connection.subscriptions);
        }
        this.connectionManager.removeConnection(connectionId);
        this.emit('client.disconnected', { connectionId });
    }
    getHooksForAction(action) {
        switch (action) {
            case 'listen':
                return [...this.hooks.pre, ...this.hooks.onListen];
            case 'unlisten':
                return [...this.hooks.pre, ...this.hooks.onUnlisten];
            case 'emit':
                return [...this.hooks.pre, ...this.hooks.onEmit];
            default:
                return this.hooks.pre;
        }
    }
}
exports.WebMQBackend = WebMQBackend;
