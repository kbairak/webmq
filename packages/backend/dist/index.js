"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebMQBackend = void 0;
const ws_1 = __importDefault(require("ws"));
const amqplib_1 = __importDefault(require("amqplib"));
// --- Backend Implementation ---
class WebMQBackend {
    constructor(options) {
        this.exchangeType = 'topic';
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
        await channel.assertExchange(this.exchangeName, this.exchangeType, { durable: false });
        await channel.close();
        const wss = new ws_1.default.Server({ port });
        wss.on('connection', (ws) => {
            this.handleConnection(ws);
        });
        console.log(`WebMQ Backend started on ws://localhost:${port}`);
    }
    async handleConnection(ws) {
        if (!this.channelModel) {
            throw new Error('RabbitMQ connection not established.');
        }
        const context = { ws, id: crypto.randomUUID() };
        const channel = await this.channelModel.createChannel();
        const clientSubscriptions = new Map();
        console.log(`Client ${context.id} connected.`);
        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                const actionHooks = this.getHooksForAction(message.action);
                const allHooks = [...this.hooks.pre, ...actionHooks];
                const run = async (index) => {
                    if (index >= allHooks.length) {
                        return this.processMessage(channel, context, message, clientSubscriptions);
                    }
                    await allHooks[index](context, message, () => run(index + 1));
                };
                await run(0);
            }
            catch (error) {
                console.error(`[${context.id}] Error processing message:`, error.message);
                ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
        });
        ws.on('close', async () => {
            console.log(`Client ${context.id} disconnected. Cleaning up resources.`);
            for (const [bindingKey, sub] of clientSubscriptions.entries()) {
                try {
                    await channel.cancel(sub.consumerTag);
                    await channel.unbindQueue(sub.queue, this.exchangeName, bindingKey);
                    await channel.deleteQueue(sub.queue);
                }
                catch (err) {
                    console.error(`Error cleaning up for bindingKey ${bindingKey}:`, err);
                }
            }
            await channel.close();
        });
    }
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
    async processMessage(channel, context, message, clientSubscriptions) {
        switch (message.action) {
            case 'emit':
                if (!message.routingKey || !message.payload)
                    throw new Error('emit requires routingKey and payload');
                channel.publish(this.exchangeName, message.routingKey, Buffer.from(JSON.stringify(message.payload)));
                break;
            case 'listen':
                if (!message.bindingKey)
                    throw new Error('listen requires a bindingKey');
                if (clientSubscriptions.has(message.bindingKey))
                    return; // Already listening
                const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
                await channel.bindQueue(queue, this.exchangeName, message.bindingKey);
                const { consumerTag } = await channel.consume(queue, (msg) => {
                    if (msg) {
                        context.ws.send(JSON.stringify({
                            type: 'message',
                            bindingKey: message.bindingKey,
                            payload: JSON.parse(msg.content.toString()),
                        }));
                        channel.ack(msg);
                    }
                });
                clientSubscriptions.set(message.bindingKey, { queue, consumerTag });
                break;
            case 'unlisten':
                if (!message.bindingKey)
                    throw new Error('unlisten requires a bindingKey');
                const sub = clientSubscriptions.get(message.bindingKey);
                if (sub) {
                    await channel.cancel(sub.consumerTag);
                    await channel.unbindQueue(sub.queue, this.exchangeName, message.bindingKey);
                    await channel.deleteQueue(sub.queue);
                    clientSubscriptions.delete(message.bindingKey);
                }
                break;
            default:
                throw new Error('Unknown action');
        }
    }
}
exports.WebMQBackend = WebMQBackend;
