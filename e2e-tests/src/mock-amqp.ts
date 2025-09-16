import { EventEmitter } from 'events';

// Shared broker state across all connections
class SharedAMQPBroker {
  private static instance: SharedAMQPBroker;

  public exchanges: Map<string, MockExchange> = new Map();
  public queues: Map<string, MockQueue> = new Map();
  public bindings: Map<string, Set<string>> = new Map(); // queue -> routing keys
  public consumers: Map<string, (msg: any) => void> = new Map();

  static getInstance(): SharedAMQPBroker {
    if (!SharedAMQPBroker.instance) {
      SharedAMQPBroker.instance = new SharedAMQPBroker();
    }
    return SharedAMQPBroker.instance;
  }

  reset() {
    this.exchanges.clear();
    this.queues.clear();
    this.bindings.clear();
    this.consumers.clear();
  }
}

// In-memory AMQP mock for fast testing
export class MockAMQPConnection extends EventEmitter {
  private channels: Map<number, MockAMQPChannel> = new Map();
  private nextChannelId = 1;
  private _closed = false;

  async createChannel(): Promise<MockAMQPChannel> {
    if (this._closed) {
      throw new Error('Connection is closed');
    }
    const channel = new MockAMQPChannel(this.nextChannelId++, this);
    this.channels.set(channel.id, channel);
    return channel;
  }

  async close(): Promise<void> {
    this._closed = true;
    for (const channel of this.channels.values()) {
      await channel.close();
    }
    this.channels.clear();
    this.emit('close');
  }

  get closed(): boolean {
    return this._closed;
  }
}

export class MockAMQPChannel extends EventEmitter {
  private broker = SharedAMQPBroker.getInstance();
  private _closed = false;

  constructor(public readonly id: number, private connection: MockAMQPConnection) {
    super();
  }

  async assertExchange(name: string, type: string, options: any = {}): Promise<{ exchange: string }> {
    if (this._closed) throw new Error('Channel is closed');

    const exchange = new MockExchange(name, type, options);
    this.broker.exchanges.set(name, exchange);
    console.log(`🔧 Mock AMQP: Created exchange '${name}' of type '${type}'`);
    return { exchange: name };
  }

  async assertQueue(name: string = '', options: any = {}): Promise<{ queue: string; messageCount: number; consumerCount: number }> {
    if (this._closed) throw new Error('Channel is closed');

    const queueName = name || `amq.gen-${Math.random().toString(36).substring(2)}`;
    const queue = new MockQueue(queueName, options);
    this.broker.queues.set(queueName, queue);
    console.log(`🔧 Mock AMQP: Created queue '${queueName}'`);

    return {
      queue: queueName,
      messageCount: queue.messages.length,
      consumerCount: queue.consumers.size
    };
  }

  async bindQueue(queue: string, exchange: string, routingKey: string): Promise<void> {
    if (this._closed) throw new Error('Channel is closed');

    if (!this.broker.bindings.has(queue)) {
      this.broker.bindings.set(queue, new Set());
    }
    this.broker.bindings.get(queue)!.add(`${exchange}:${routingKey}`);
    console.log(`🔧 Mock AMQP: Bound queue '${queue}' to exchange '${exchange}' with routing key '${routingKey}'`);
  }

  async publish(exchange: string, routingKey: string, content: Buffer, options: any = {}): Promise<boolean> {
    if (this._closed) throw new Error('Channel is closed');

    const message = {
      content,
      fields: {
        exchange,
        routingKey,
        deliveryTag: Math.floor(Math.random() * 1000000),
      },
      properties: options.properties || {}
    };

    console.log(`🔧 Mock AMQP: Publishing to exchange '${exchange}' with routing key '${routingKey}'`);

    // Route message to matching queues
    for (const [queueName, boundKeys] of this.broker.bindings.entries()) {
      const matchesBinding = Array.from(boundKeys).some(key => {
        const keyParts = key.split(':');
        if (keyParts.length !== 2) return false;

        const [boundExchange, boundRoutingKey] = keyParts;
        if (boundExchange !== exchange) return false;

        // Topic matching: * matches one word, # matches zero or more words
        const pattern = boundRoutingKey
          .replace(/\./g, '\\.')  // Escape dots
          .replace(/\*/g, '[^.]+') // * matches one word (non-dot chars)
          .replace(/#/g, '.*');    // # matches zero or more words

        const regex = new RegExp(`^${pattern}$`);
        const matches = regex.test(routingKey);

        console.log(`🔍 Mock AMQP: Checking binding ${boundRoutingKey} against ${routingKey} -> ${matches}`);

        return matches;
      });

      if (matchesBinding) {
        const queue = this.broker.queues.get(queueName);
        if (queue) {
          console.log(`📬 Mock AMQP: Delivering message to queue ${queueName}`);
          // Deliver to consumers immediately (synchronously for reliability)
          for (const consumer of queue.consumers.values()) {
            try {
              const msg = {
                ...message,
                ack: () => {}, // Mock ack function
                nack: () => {} // Mock nack function
              };
              consumer(msg);
            } catch (error) {
              console.warn('Error in consumer:', error);
            }
          }
        }
      }
    }

    return true;
  }

  async consume(queue: string, onMessage: (msg: any) => void, options: any = {}): Promise<{ consumerTag: string }> {
    if (this._closed) throw new Error('Channel is closed');

    const consumerTag = `ctag-${Math.random().toString(36).substring(2)}`;
    const mockQueue = this.broker.queues.get(queue);

    if (!mockQueue) {
      throw new Error(`Queue '${queue}' not found`);
    }

    mockQueue.consumers.set(consumerTag, onMessage);
    this.broker.consumers.set(consumerTag, onMessage);
    console.log(`🔧 Mock AMQP: Consumer registered for queue '${queue}' with tag '${consumerTag}'`);

    // Deliver existing messages
    for (const message of mockQueue.messages) {
      setImmediate(() => onMessage({ ...message }));
    }

    return { consumerTag };
  }

  async ack(message: any): Promise<void> {
    // Mock ack - just return success
  }

  async nack(message: any, allUpTo?: boolean, requeue?: boolean): Promise<void> {
    // Mock nack - just return success
  }

  async close(): Promise<void> {
    this._closed = true;
    // Note: We don't clear shared broker state on individual channel close
    this.emit('close');
  }

  get closed(): boolean {
    return this._closed;
  }
}

class MockExchange {
  constructor(
    public name: string,
    public type: string,
    public options: any
  ) {}
}

class MockQueue {
  public messages: any[] = [];
  public consumers: Map<string, (msg: any) => void> = new Map();

  constructor(
    public name: string,
    public options: any
  ) {}
}

// Mock amqplib module functions - export as default export to match amqplib
export default {
  connect: async (url: string): Promise<MockAMQPConnection> => {
    console.log('🔧 Mock AMQP: connect() called with url:', url);
    // Simulate connection delay (much faster than real RabbitMQ)
    await new Promise(resolve => setTimeout(resolve, 10));
    return new MockAMQPConnection();
  }
};

// Named export for connect function
export const connect = async (url: string): Promise<MockAMQPConnection> => {
  console.log('🔧 Mock AMQP: connect() (named export) called with url:', url);
  await new Promise(resolve => setTimeout(resolve, 10));
  return new MockAMQPConnection();
};

// Helper function to reset broker state (useful for test isolation)
export const resetMockBroker = (): void => {
  SharedAMQPBroker.getInstance().reset();
  console.log('🔧 Mock AMQP: Broker state reset');
};