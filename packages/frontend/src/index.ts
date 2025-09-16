import { EventEmitter } from 'events';

// --- Type Definitions ---
type MessageCallback = (payload: any) => void;

// --- Class Implementation ---

/**
 * A client for interacting with a WebMQ backend.
 */
export class WebMQClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private connectionPromise: Promise<void> | null = null;
  private isConnected = false;

  private messageListeners: Map<string, MessageCallback[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: number | null = null;

  // Message queuing for offline scenarios
  private messageQueue: Array<{ routingKey: string; payload: any; messageId: string; resolve: (value?: any) => void; reject: (reason?: any) => void }> = [];
  private maxQueueSize = 100;

  // Message acknowledgment tracking
  private pendingMessages: Map<string, { resolve: (value?: any) => void; reject: (reason?: any) => void; timeout: ReturnType<typeof setTimeout> }> = new Map();
  private messageTimeout = 10000; // 10 seconds default

  constructor() {
    super();
  }

  /**
   * Configures the WebSocket server URL.
   * @param url The WebSocket URL (e.g., 'ws://localhost:8080')
   * @param options Configuration options
   */
  public setup(url: string, options: { maxReconnectAttempts?: number; maxQueueSize?: number; messageTimeout?: number } = {}) {
    this.url = url;
    if (options.maxReconnectAttempts !== undefined) {
      this.maxReconnectAttempts = options.maxReconnectAttempts;
    }
    if (options.maxQueueSize !== undefined) {
      this.maxQueueSize = options.maxQueueSize;
    }
    if (options.messageTimeout !== undefined) {
      this.messageTimeout = options.messageTimeout;
    }
  }

  /**
   * Explicitly initiates the connection to the server.
   * Optional: If not called, connection is made on the first `emit` or `listen`.
   */
  public connect(): Promise<void> {
    if (!this.connectionPromise) {
      if (!this.url) {
        return Promise.reject(new Error('URL not set. Call setup(url) first.'));
      }

      this.connectionPromise = new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.url!);

        this.ws.addEventListener('open', () => {
          console.log('WebMQ client connected.');
          const wasReconnection = this.reconnectAttempts > 0;
          this.isConnected = true;
          this.reconnectAttempts = 0; // Reset attempts on successful connection
          if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
          }
          // Resubscribe to all existing listeners on reconnection
          for (const bindingKey of this.messageListeners.keys()) {
            this.ws?.send(JSON.stringify({ action: 'listen', bindingKey }));
          }

          // Send any queued messages
          this.flushMessageQueue();

          // Emit connection state events
          if (wasReconnection) {
            super.emit('reconnect');
          } else {
            super.emit('connect');
          }

          resolve();
        });

        this.ws.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(event.data);

            if (message.type === 'message' && message.bindingKey) {
              // Handle regular topic messages
              const callbacks = this.messageListeners.get(message.bindingKey);
              if (callbacks) {
                callbacks.forEach(cb => cb(message.payload));
              }
            } else if (message.type === 'ack' && message.messageId) {
              // Handle message acknowledgments
              this.handleMessageAck(message.messageId, message.status === 'success' ? null : new Error(message.error || 'Message failed'));
            } else if (message.type === 'nack' && message.messageId) {
              // Handle message rejections
              this.handleMessageAck(message.messageId, new Error(message.error || 'Message rejected by server'));
            }
          } catch (e) {
            console.error('Error parsing message from server:', e);
          }
        });

        this.ws.addEventListener('error', (err) => {
          console.error('WebMQ client error:', err);
          if (!this.isConnected) {
            reject(new Error('WebSocket connection failed.'));
          }
        });

        this.ws.addEventListener('close', () => {
          console.log('WebMQ client disconnected.');
          this.isConnected = false;
          this.ws = null;
          this.connectionPromise = null;

          // Emit disconnect event
          super.emit('disconnect');

          // Auto-reconnect if we have listeners and haven't exceeded retry limit
          if (this.messageListeners.size > 0 && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`WebMQ client failed to reconnect after ${this.maxReconnectAttempts} attempts.`);
          }
        });
      });
    }
    return this.connectionPromise;
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000); // Cap at 30 seconds
    console.log(`WebMQ client attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(() => {
        // Connection failed, scheduleReconnect will be called again from close event
      });
    }, delay) as any; // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s...
  }

  private async _ensureConnected(): Promise<void> {
    if (!this.isConnected && !this.connectionPromise) {
      await this.connect();
    }
    return this.connectionPromise!;
  }

  /**
   * Sends a message to the backend and waits for acknowledgment.
   * @param routingKey The key to route the message by.
   * @param payload The data to send.
   * @returns Promise that resolves when server confirms delivery or rejects on failure/timeout
   */
  public async send(routingKey: string, payload: any): Promise<void> {
    const messageId = this.generateMessageId();

    return new Promise<void>((resolve, reject) => {
      if (this.isConnected && this.ws) {
        // Send immediately if connected
        this.sendWithAck(routingKey, payload, messageId, resolve, reject);
      } else {
        // Queue message if disconnected
        this.queueMessage(routingKey, payload, messageId, resolve, reject);
        // Try to connect (will flush queue when connected)
        this._ensureConnected().catch(reject);
      }
    });
  }

  /**
   * Listens for messages matching a binding pattern.
   * @param bindingKey The pattern to listen for (e.g., 'chat.message', 'user.*').
   * @param callback The function to call with the message payload.
   */
  public async listen(bindingKey: string, callback: MessageCallback): Promise<void> {
    await this._ensureConnected();
    const existing = this.messageListeners.get(bindingKey);
    if (existing) {
      existing.push(callback);
    } else {
      this.messageListeners.set(bindingKey, [callback]);
      this.ws?.send(JSON.stringify({ action: 'listen', bindingKey }));
    }
  }

  /**
   * Stops listening for messages.
   * @param bindingKey The pattern to stop listening for.
   * @param callback The specific callback to remove.
   */
  public async unlisten(bindingKey: string, callback: MessageCallback): Promise<void> {
    const callbacks = this.messageListeners.get(bindingKey);
    if (!callbacks) return;

    const filteredCallbacks = callbacks.filter(cb => cb !== callback);

    if (filteredCallbacks.length > 0) {
      this.messageListeners.set(bindingKey, filteredCallbacks);
    } else {
      this.messageListeners.delete(bindingKey);
      await this._ensureConnected();
      this.ws?.send(JSON.stringify({ action: 'unlisten', bindingKey }));
    }
  }

  /**
   * Disconnects from the WebSocket server.
   * @param options Configuration for handling active listeners
   */
  public disconnect(options: { onActiveListeners?: 'ignore' | 'throw' | 'clear' } = {}): void {
    const { onActiveListeners = 'ignore' } = options;

    // Validate option first
    if (!['ignore', 'throw', 'clear'].includes(onActiveListeners)) {
      throw new Error(`Invalid onActiveListeners option: ${onActiveListeners}. Must be 'ignore', 'throw', or 'clear'.`);
    }

    if (this.messageListeners.size > 0) {
      switch (onActiveListeners) {
        case 'ignore':
          return; // Do nothing, keep connection alive

        case 'throw':
          throw new Error(`Cannot disconnect: ${this.messageListeners.size} active listeners. Use onActiveListeners: 'clear' or unlisten() first.`);

        case 'clear':
          this.messageListeners.clear(); // Remove all listeners
          break;
      }
    }

    // Actually disconnect
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = 0; // Reset attempts on manual disconnect
    if (this.ws) {
      this.ws.close();
    }
    this.ws = null;
    this.connectionPromise = null;
    this.isConnected = false;
  }

  /**
   * Queues a message when disconnected, with configurable size limits.
   * @param routingKey The routing key for the message
   * @param payload The message payload
   * @param messageId The unique message ID
   * @param resolve Promise resolve function
   * @param reject Promise reject function
   */
  private queueMessage(routingKey: string, payload: any, messageId: string, resolve: (value?: any) => void, reject: (reason?: any) => void): void {
    if (this.messageQueue.length >= this.maxQueueSize) {
      // Remove oldest message to make room (FIFO) and reject its promise
      const droppedMessage = this.messageQueue.shift();
      if (droppedMessage) {
        droppedMessage.reject(new Error('Message dropped: queue full'));
      }
      console.warn(`WebMQ message queue full (${this.maxQueueSize}). Dropped oldest message.`);
    }
    this.messageQueue.push({ routingKey, payload, messageId, resolve, reject });
    console.log(`WebMQ message queued. Queue size: ${this.messageQueue.length}/${this.maxQueueSize}`);
  }

  /**
   * Sends all queued messages when connection is restored.
   */
  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return;

    console.log(`WebMQ flushing ${this.messageQueue.length} queued messages...`);
    const queuedMessages = [...this.messageQueue];
    this.messageQueue = []; // Clear queue

    for (const message of queuedMessages) {
      if (this.ws) {
        this.sendWithAck(message.routingKey, message.payload, message.messageId, message.resolve, message.reject);
      } else {
        message.reject(new Error('Connection lost during queue flush'));
      }
    }
  }

  /**
   * Returns the current number of queued messages.
   */
  public getQueueSize(): number {
    return this.messageQueue.length;
  }

  /**
   * Clears all queued messages.
   */
  public clearQueue(): void {
    const droppedMessages = [...this.messageQueue];
    this.messageQueue = [];

    // Reject all cleared messages
    for (const message of droppedMessages) {
      message.reject(new Error('Message cleared from queue'));
    }

    if (droppedMessages.length > 0) {
      console.log(`WebMQ cleared ${droppedMessages.length} queued messages.`);
    }
  }

  /**
   * Generates a unique message ID for tracking acknowledgments.
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Sends a message with acknowledgment tracking.
   */
  private sendWithAck(routingKey: string, payload: any, messageId: string, resolve: (value?: any) => void, reject: (reason?: any) => void): void {
    // Set up timeout for this message
    const timeoutId = setTimeout(() => {
      this.pendingMessages.delete(messageId);
      reject(new Error(`Message timeout after ${this.messageTimeout}ms`));
    }, this.messageTimeout);

    // Track the pending message
    this.pendingMessages.set(messageId, { resolve, reject, timeout: timeoutId });

    // Send the message
    this.ws?.send(JSON.stringify({
      action: 'emit',
      routingKey,
      payload,
      messageId,
      requireAck: true
    }));
  }

  /**
   * Handles acknowledgment or rejection of a message.
   */
  private handleMessageAck(messageId: string, error: Error | null): void {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) return;

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingMessages.delete(messageId);

    // Resolve or reject the promise
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve();
    }
  }

}

// --- Hybrid Singleton/Instance Pattern ---

const defaultClient = new WebMQClient();

export const setup = defaultClient.setup.bind(defaultClient);
export const connect = defaultClient.connect.bind(defaultClient);
export const send = defaultClient.send.bind(defaultClient);
export const listen = defaultClient.listen.bind(defaultClient);
export const unlisten = defaultClient.unlisten.bind(defaultClient);
export const disconnect = defaultClient.disconnect.bind(defaultClient);
export const getQueueSize = defaultClient.getQueueSize.bind(defaultClient);
export const clearQueue = defaultClient.clearQueue.bind(defaultClient);

// Keep emit as an alias for backwards compatibility
export const emit = defaultClient.send.bind(defaultClient);

// Export the defaultClient for event handling
export { defaultClient as client };
