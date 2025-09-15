"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebMQBackend = void 0;
const ws_1 = require("ws");
const amqplib_1 = __importDefault(require("amqplib"));
const crypto_1 = __importDefault(require("crypto"));
// --- Connection Implementation ---
class Connection {
    constructor(ws, channel, backend) {
        this.subscriptions = new Map();
        this.id = crypto_1.default.randomUUID();
        this.ws = ws;
        this.channel = channel;
        this.backend = backend;
    }
    async initialize() {
        console.log(`Client ${this.id} connected.`);
        this.setupEventHandlers();
    }
    setupEventHandlers() {
        this.ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                await this.processMessage(message);
            }
            catch (error) {
                console.error(`[${this.id}] Error processing message:`, error.message);
                this.ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
        });
        this.ws.on('close', async () => {
            await this.cleanup();
        });
    }
    async processMessage(message) {
        console.log(`[${this.id}] Processing message:`, JSON.stringify(message));
        const context = { ws: this.ws, id: this.id };
        const actionHooks = this.backend.getHooksForAction(message.action);
        const allHooks = [...this.backend.getPreHooks(), ...actionHooks];
        const run = async (index) => {
            if (index >= allHooks.length) {
                console.log(`[${this.id}] Executing action: ${message.action}`);
                return this.executeAction(message);
            }
            console.log(`[${this.id}] Running hook ${index}/${allHooks.length}`);
            await allHooks[index](context, message, () => run(index + 1));
        };
        try {
            await run(0);
            console.log(`[${this.id}] Message processed successfully`);
        }
        catch (error) {
            console.error(`[${this.id}] Error in processMessage:`, error.message);
            console.error(`[${this.id}] Stack trace:`, error.stack);
            throw error;
        }
    }
    async executeAction(message) {
        console.log(`[${this.id}] Executing ${message.action} action`);
        try {
            switch (message.action) {
                case 'emit':
                    console.log(`[${this.id}] Emit - routingKey: ${message.routingKey}, payload:`, message.payload);
                    if (!message.routingKey || !message.payload) {
                        throw new Error('emit requires routingKey and payload');
                    }
                    await this.channel.publish(this.backend.getExchangeName(), message.routingKey, Buffer.from(JSON.stringify(message.payload)));
                    console.log(`[${this.id}] Message published successfully`);
                    break;
                case 'listen':
                    console.log(`[${this.id}] Listen - bindingKey: ${message.bindingKey}`);
                    if (!message.bindingKey)
                        throw new Error('listen requires a bindingKey');
                    if (this.subscriptions.has(message.bindingKey)) {
                        console.log(`[${this.id}] Already listening to ${message.bindingKey}`);
                        return; // Already listening
                    }
                    const { queue } = await this.channel.assertQueue('', { exclusive: true, autoDelete: true });
                    console.log(`[${this.id}] Queue created: ${queue}`);
                    await this.channel.bindQueue(queue, this.backend.getExchangeName(), message.bindingKey);
                    console.log(`[${this.id}] Queue bound to exchange`);
                    const { consumerTag } = await this.channel.consume(queue, (msg) => {
                        if (msg) {
                            console.log(`[${this.id}] Received message from RabbitMQ:`, msg.content.toString());
                            this.ws.send(JSON.stringify({
                                type: 'message',
                                bindingKey: message.bindingKey,
                                payload: JSON.parse(msg.content.toString()),
                            }));
                            this.channel.ack(msg);
                        }
                    });
                    this.subscriptions.set(message.bindingKey, { queue, consumerTag });
                    console.log(`[${this.id}] Consumer set up with tag: ${consumerTag}`);
                    break;
                case 'unlisten':
                    console.log(`[${this.id}] Unlisten - bindingKey: ${message.bindingKey}`);
                    if (!message.bindingKey)
                        throw new Error('unlisten requires a bindingKey');
                    const sub = this.subscriptions.get(message.bindingKey);
                    if (sub) {
                        await this.channel.cancel(sub.consumerTag);
                        await this.channel.unbindQueue(sub.queue, this.backend.getExchangeName(), message.bindingKey);
                        await this.channel.deleteQueue(sub.queue);
                        this.subscriptions.delete(message.bindingKey);
                        console.log(`[${this.id}] Unsubscribed from ${message.bindingKey}`);
                    }
                    else {
                        console.log(`[${this.id}] No subscription found for ${message.bindingKey}`);
                    }
                    break;
                default:
                    throw new Error(`Unknown action: ${message.action}`);
            }
            console.log(`[${this.id}] Action ${message.action} completed successfully`);
        }
        catch (error) {
            console.error(`[${this.id}] Error in executeAction(${message.action}):`, error.message);
            console.error(`[${this.id}] Stack trace:`, error.stack);
            throw error;
        }
    }
    async cleanup() {
        console.log(`Client ${this.id} disconnected. Cleaning up resources.`);
        for (const [bindingKey, sub] of this.subscriptions.entries()) {
            try {
                await this.channel.cancel(sub.consumerTag);
                await this.channel.unbindQueue(sub.queue, this.backend.getExchangeName(), bindingKey);
                await this.channel.deleteQueue(sub.queue);
            }
            catch (err) {
                console.error(`Error cleaning up for bindingKey ${bindingKey}:`, err);
            }
        }
        await this.channel.close();
    }
}
// --- Backend Implementation ---
class WebMQBackend {
    constructor(options) {
        this.channelModel = null;
        this.rabbitmqUrl = options.rabbitmqUrl;
        this.exchangeName = options.exchangeName;
        this.hooks = {
            pre: options.hooks?.pre || [],
            onListen: options.hooks?.onListen || [],
            onEmit: options.hooks?.onEmit || [],
            onUnlisten: options.hooks?.onUnlisten || [],
        };
    }
    async start(port) {
        console.log('Starting WebMQ Backend...');
        this.channelModel = await amqplib_1.default.connect(this.rabbitmqUrl);
        const channel = await this.channelModel.createChannel();
        await channel.assertExchange(this.exchangeName, 'topic', { durable: false });
        await channel.close();
        const wss = new ws_1.WebSocketServer({ port });
        wss.on('connection', (ws) => {
            this.handleConnection(ws);
        });
        console.log(`WebMQ Backend started on ws://localhost:${port}`);
    }
    async handleConnection(ws) {
        if (!this.channelModel) {
            throw new Error('RabbitMQ connection not established.');
        }
        const channel = await this.channelModel.createChannel();
        const connection = new Connection(ws, channel, this);
        await connection.initialize();
    }
    // Public methods for Connection class to access
    getHooksForAction(action) {
        switch (action) {
            case 'listen':
                return this.hooks.onListen;
            case 'unlisten':
                return this.hooks.onUnlisten;
            case 'emit':
                return this.hooks.onEmit;
            default:
                return [];
        }
    }
    getPreHooks() {
        return this.hooks.pre;
    }
    getExchangeName() {
        return this.exchangeName;
    }
}
exports.WebMQBackend = WebMQBackend;
