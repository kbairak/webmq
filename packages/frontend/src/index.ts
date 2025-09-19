import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Logger, LogLevel } from './common/logger';
import {
  Message,
  OutgoingMessage,
  IncomingMessage,
  ListenMessage,
  UnlistenMessage,
  IdentifyMessage,
  EmitMessage,
  DataMessage,
  AckMessage,
  NackMessage,
  ClientMessage,
  ServerMessage,
  ClientHookContext,
  ClientHookMessage,
  ClientHook,
  ClientHooks,
  WebMQClientOptions,
  DisconnectOptions,
  QueuedMessage,
  PendingMessage,
  MessageCallback,
} from './interfaces';


// --- Core Components ---

/**
 * Manages WebSocket connection lifecycle and reconnection logic
 */
class ConnectionManager {
  private ws: WebSocket | null = null;
  private connectionPromise: Promise<void> | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: number | null = null;
  private url: string | null = null;
  private logger: Logger;
  private eventEmitter: EventEmitter;

  constructor(eventEmitter: EventEmitter, logger: Logger) {
    this.eventEmitter = eventEmitter;
    this.logger = logger;
  }

  setUrl(url: string): void {
    this.url = url;
  }

  setMaxReconnectAttempts(attempts: number): void {
    this.maxReconnectAttempts = attempts;
  }

  getConnection(): WebSocket | null {
    return this.ws;
  }

  isReady(): boolean {
    return this.isConnected;
  }

  connect(): Promise<void> {
    if (!this.connectionPromise) {
      if (!this.url) {
        return Promise.reject(new Error('URL not set. Call setup(url) first.'));
      }

      this.connectionPromise = new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.url!);

        this.ws.addEventListener('open', () => {
          this.logger.info('WebMQ client connected.');
          const wasReconnection = this.reconnectAttempts > 0;
          this.isConnected = true;
          this.reconnectAttempts = 0;
          if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
          }

          this.eventEmitter.emit('connection:ready', { wasReconnection });
          resolve();
        });

        this.ws.addEventListener('message', (event) => {
          this.eventEmitter.emit('message:received', event.data);
        });

        this.ws.addEventListener('error', (err) => {
          this.logger.error('WebMQ client error:', err);
          const wasConnected = this.isConnected;
          this.isConnected = false;
          this.eventEmitter.emit('connection:error', { err, wasConnected });
          if (!wasConnected) {
            reject(new Error('WebSocket connection failed.'));
          }
        });

        this.ws.addEventListener('close', () => {
          this.logger.info('WebMQ client disconnected.');
          this.isConnected = false;
          this.ws = null;
          this.connectionPromise = null;
          this.eventEmitter.emit('connection:closed');
        });
      });
    }
    return this.connectionPromise;
  }

  scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      30000
    );
    this.logger.info(
      `WebMQ client attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch(() => {
        // Connection failed, scheduleReconnect will be called again from close event
      });
    }, delay) as any;
  }

  shouldReconnect(hasListeners: boolean, hasQueuedMessages: boolean): boolean {
    return (
      (hasListeners || hasQueuedMessages) &&
      this.reconnectAttempts < this.maxReconnectAttempts
    );
  }

  hasExceededMaxAttempts(): boolean {
    return this.reconnectAttempts >= this.maxReconnectAttempts;
  }

  send(data: string): void {
    this.ws?.send(data);
  }

  close(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws) {
      this.ws.close();
    }
    this.ws = null;
    this.connectionPromise = null;
    this.isConnected = false;
  }
}

/**
 * Manages session identity for persistent queues
 */
class SessionManager {
  private sessionId: string | null = null;
  private sessionIdentified = false;
  private logger: Logger;
  private connectionManager: ConnectionManager;

  constructor(connectionManager: ConnectionManager, logger: Logger) {
    this.connectionManager = connectionManager;
    this.logger = logger;
    this.initializeSessionId();
  }

  private initializeSessionId(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        this.sessionId = localStorage.getItem('webmq-session-id');
      }

      if (!this.sessionId) {
        this.sessionId = uuidv4();
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('webmq-session-id', this.sessionId);
        }
      }

      this.logger.debug(`Session ID: ${this.sessionId}`);
    } catch (error) {
      this.sessionId = uuidv4();
      this.logger.warn('localStorage unavailable, using temporary session ID');
    }
  }

  sendIdentification(): void {
    if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
      this.sessionIdentified = true;
      return;
    }

    if (
      this.sessionId &&
      this.connectionManager.getConnection() &&
      !this.sessionIdentified
    ) {
      const identifyMessage: IdentifyMessage = {
        action: 'identify',
        sessionId: this.sessionId,
      };
      // TODO: Should we wait for an ack on this? Until then, further published messages could be queued
      this.connectionManager.send(JSON.stringify(identifyMessage));
      this.sessionIdentified = true;
      this.logger.debug(`Sent session identification: ${this.sessionId}`);
    }
  }

  resetIdentification(): void {
    this.sessionIdentified = false;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

/**
 * Executes message actions with hook support
 */
class ActionExecutor {
  private hooks: Required<ClientHooks>;
  private hookContext: ClientHookContext;
  private logger: Logger;

  constructor(client: WebMQClient, logger: Logger) {
    this.hooks = {
      pre: [],
      onPublish: [],
      onMessage: [],
      onListen: [],
    };
    this.hookContext = { client };
    this.logger = logger;
  }

  setHooks(hooks: ClientHooks): void {
    this.hooks.pre = hooks.pre || [];
    this.hooks.onPublish = hooks.onPublish || [];
    this.hooks.onMessage = hooks.onMessage || [];
    this.hooks.onListen = hooks.onListen || [];
  }

  async executePublish(
    routingKey: string,
    payload: any,
    sendAction: (finalRoutingKey: string, finalPayload: any) => Promise<void>
  ): Promise<void> {
    const message: ClientHookMessage = {
      action: 'publish',
      routingKey,
      payload,
    };

    const mainAction = async (): Promise<void> => {
      await sendAction(message.routingKey!, message.payload);
    };

    await this.executeHooks(
      this.hooks.pre,
      this.hooks.onPublish,
      message,
      mainAction
    );
  }

  async executeListen(
    bindingKey: string,
    callback: MessageCallback,
    listenAction: (
      finalBindingKey: string,
      finalCallback: MessageCallback
    ) => Promise<void>
  ): Promise<void> {
    const message: ClientHookMessage = {
      action: 'listen',
      bindingKey,
      callback,
    };

    const mainAction = async (): Promise<void> => {
      await listenAction(message.bindingKey!, message.callback!);
    };

    await this.executeHooks(
      this.hooks.pre,
      this.hooks.onListen,
      message,
      mainAction
    );
  }

  async executeMessage(
    bindingKey: string,
    payload: any,
    callbacks: MessageCallback[]
  ): Promise<void> {
    const hookMessage: ClientHookMessage = {
      action: 'message',
      bindingKey,
      payload,
    };

    const mainAction = async (): Promise<void> => {
      callbacks.forEach((cb) => cb(hookMessage.payload));
    };

    try {
      await this.executeHooks(
        this.hooks.pre,
        this.hooks.onMessage,
        hookMessage,
        mainAction
      );
    } catch (error) {
      this.logger.error(
        `Message hook failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async executeHooks(
    preHooks: ClientHook[],
    actionHooks: ClientHook[],
    message: ClientHookMessage,
    mainAction: () => Promise<void>
  ): Promise<void> {
    const allHooks = [...preHooks, ...actionHooks];

    const run = async (index: number): Promise<void> => {
      if (index >= allHooks.length) {
        return mainAction();
      }
      await allHooks[index](this.hookContext, message, () => run(index + 1));
    };

    await run(0);
  }
}

/**
 * Manages message publishing with acknowledgments and queuing
 */
class MessagePublisher {
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private messageQueue: QueuedMessage[] = [];
  private maxQueueSize = 100;
  private messageTimeout = 10000;
  private connectionManager: ConnectionManager;
  private logger: Logger;

  constructor(connectionManager: ConnectionManager, logger: Logger) {
    this.connectionManager = connectionManager;
    this.logger = logger;
  }

  setMaxQueueSize(size: number): void {
    this.maxQueueSize = size;
  }

  setMessageTimeout(timeout: number): void {
    this.messageTimeout = timeout;
  }

  async publish(routingKey: string, payload: any): Promise<void> {
    const messageId = uuidv4();

    return new Promise<void>((resolve, reject) => {
      if (this.connectionManager.isReady()) {
        this.sendWithAck(routingKey, payload, messageId, resolve, reject);
      } else {
        this.queueMessage(routingKey, payload, messageId, resolve, reject);
      }
    });
  }

  private sendWithAck(
    routingKey: string,
    payload: any,
    messageId: string,
    resolve: (value?: any) => void,
    reject: (reason?: any) => void
  ): void {
    const timeoutId = setTimeout(() => {
      this.pendingMessages.delete(messageId);
      reject(new Error(`Message timeout after ${this.messageTimeout}ms`));
    }, this.messageTimeout);

    this.pendingMessages.set(messageId, {
      resolve,
      reject,
      timeout: timeoutId,
    });

    const emitMessage: EmitMessage = {
      action: 'publish',
      routingKey,
      payload,
      messageId,
    };
    this.connectionManager.send(JSON.stringify(emitMessage));
  }

  private queueMessage(
    routingKey: string,
    payload: any,
    messageId: string,
    resolve: (value?: any) => void,
    reject: (reason?: any) => void
  ): void {
    if (this.messageQueue.length >= this.maxQueueSize) {
      const droppedMessage = this.messageQueue.shift();
      if (droppedMessage) {
        droppedMessage.reject(new Error('Message dropped: queue full'));
      }
      this.logger.warn(
        `WebMQ message queue full (${this.maxQueueSize}). Dropped oldest message.`
      );
    }
    this.messageQueue.push({ routingKey, payload, messageId, resolve, reject });
    this.logger.info(
      `WebMQ message queued. Queue size: ${this.messageQueue.length}/${this.maxQueueSize}`
    );
  }

  flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return;

    this.logger.info(
      `WebMQ flushing ${this.messageQueue.length} queued messages...`
    );
    const queuedMessages = [...this.messageQueue];
    this.messageQueue = [];

    for (const message of queuedMessages) {
      if (this.connectionManager.getConnection()) {
        this.sendWithAck(
          message.routingKey,
          message.payload,
          message.messageId,
          message.resolve,
          message.reject
        );
      } else {
        message.reject(new Error('Connection lost during queue flush'));
      }
    }
  }

  handleMessageAck(messageId: string, error: Error | null): void {
    const pending = this.pendingMessages.get(messageId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingMessages.delete(messageId);

    if (error) {
      pending.reject(error);
    } else {
      pending.resolve();
    }
  }

  clearQueue(): void {
    const droppedMessages = [...this.messageQueue];
    this.messageQueue = [];

    for (const message of droppedMessages) {
      message.reject(new Error('Message cleared from queue'));
    }

    if (droppedMessages.length > 0) {
      this.logger.info(
        `WebMQ cleared ${droppedMessages.length} queued messages.`
      );
    }
  }

  rejectQueuedMessages(reason: string): void {
    for (const message of this.messageQueue) {
      message.reject(new Error(reason));
    }
    this.messageQueue = [];
  }

  getQueueSize(): number {
    return this.messageQueue.length;
  }

  hasQueuedMessages(): boolean {
    return this.messageQueue.length > 0;
  }
}

/**
 * Manages subscription listeners and server communication
 */
class SubscriptionManager {
  private messageListeners: Map<string, MessageCallback[]> = new Map();
  private connectionManager: ConnectionManager;
  private logger: Logger;

  constructor(connectionManager: ConnectionManager, logger: Logger) {
    this.connectionManager = connectionManager;
    this.logger = logger;
  }

  async listen(bindingKey: string, callback: MessageCallback): Promise<void> {
    const existing = this.messageListeners.get(bindingKey);
    if (existing) {
      existing.push(callback);
      return; // Don't send another listen message
    } else {
      this.messageListeners.set(bindingKey, [callback]);
    }

    // Send listen message for the first listener on this key
    if (this.connectionManager.isReady()) {
      const listenMessage: ListenMessage = { action: 'listen', bindingKey };
      this.connectionManager.send(JSON.stringify(listenMessage));
    }
  }

  async unlisten(bindingKey: string, callback: MessageCallback): Promise<void> {
    const callbacks = this.messageListeners.get(bindingKey);
    if (!callbacks) return;

    const filteredCallbacks = callbacks.filter((cb) => cb !== callback);

    if (filteredCallbacks.length > 0) {
      this.messageListeners.set(bindingKey, filteredCallbacks);
    } else {
      this.messageListeners.delete(bindingKey);
      if (this.connectionManager.isReady()) {
        const unlistenMessage: UnlistenMessage = {
          action: 'unlisten',
          bindingKey,
        };
        this.connectionManager.send(JSON.stringify(unlistenMessage));
      }
    }
  }

  restoreAllListeners(): void {
    for (const bindingKey of Array.from(this.messageListeners.keys())) {
      const listenMessage: ListenMessage = { action: 'listen', bindingKey };
      this.connectionManager.send(JSON.stringify(listenMessage));
    }
  }

  getCallbacks(bindingKey: string): MessageCallback[] | undefined {
    return this.messageListeners.get(bindingKey);
  }

  hasListeners(): boolean {
    return this.messageListeners.size > 0;
  }

  clear(): void {
    this.messageListeners.clear();
  }

  size(): number {
    return this.messageListeners.size;
  }
}

// --- Main Client Class ---

/**
 * A client for interacting with a WebMQ backend.
 *
 * @example
 * ```javascript
 * import { setup, listen, publish } from 'webmq-frontend';
 *
 * setup('ws://localhost:8080');
 * listen('chat.room.1', (message) => console.log('Received:', message));
 * await publish('chat.room.1', { text: 'Hello World!' });
 * ```
 */
export class WebMQClient extends EventEmitter {
  // Core components
  private connectionManager: ConnectionManager;
  private sessionManager: SessionManager;
  private actionExecutor: ActionExecutor;
  private messagePublisher: MessagePublisher;
  private subscriptionManager: SubscriptionManager;

  // Logger instance - default to silent in test environments
  private logger: Logger;

  constructor(url: string = '', options: WebMQClientOptions = {}) {
    super();

    // Initialize logger - default to silent in test environments
    const initialLevel =
      typeof process !== 'undefined' && process.env.NODE_ENV === 'test'
        ? 'silent'
        : 'error';
    this.logger = new Logger(initialLevel, 'WebMQClient');

    // Initialize components
    this.connectionManager = new ConnectionManager(
      this,
      this.logger.child('ConnectionManager')
    );
    this.sessionManager = new SessionManager(
      this.connectionManager,
      this.logger.child('SessionManager')
    );
    this.actionExecutor = new ActionExecutor(
      this,
      this.logger.child('ActionExecutor')
    );
    this.messagePublisher = new MessagePublisher(
      this.connectionManager,
      this.logger.child('MessagePublisher')
    );
    this.subscriptionManager = new SubscriptionManager(
      this.connectionManager,
      this.logger.child('SubscriptionManager')
    );

    // Set up event handlers
    this.setupEventHandlers();

    this.setup(url, options);
  }

  /**
   * Set up internal event handlers to coordinate between components
   */
  private setupEventHandlers(): void {
    // Handle connection ready
    this.on('connection:ready', ({ wasReconnection }) => {
      this.sessionManager.sendIdentification();
      this.subscriptionManager.restoreAllListeners();
      this.messagePublisher.flushMessageQueue();

      if (wasReconnection) {
        // TODO: Does this need to be 'super'?
        super.emit('reconnect');
      } else {
        super.emit('connect');
      }
    });

    // Connection errors are handled directly in the WebSocket error event listener

    // Handle connection closed
    this.on('connection:closed', () => {
      this.sessionManager.resetIdentification();
      super.emit('disconnect');

      // Auto-reconnect logic
      const shouldReconnect = this.connectionManager.shouldReconnect(
        this.subscriptionManager.hasListeners(),
        this.messagePublisher.hasQueuedMessages()
      );

      if (shouldReconnect) {
        this.connectionManager.scheduleReconnect();
      } else if (this.connectionManager.hasExceededMaxAttempts()) {
        this.logger.error(
          `WebMQ client failed to reconnect after maximum attempts.`
        );
        this.messagePublisher.rejectQueuedMessages(
          'Failed to connect after maximum retry attempts'
        );
      }
    });

    // Handle incoming messages
    this.on('message:received', async (data: string) => {
      try {
        const message: ServerMessage = JSON.parse(data);

        switch (message.action) {
          case 'message': {
            const dataMessage = message as DataMessage;
            const callbacks = this.subscriptionManager.getCallbacks(
              dataMessage.bindingKey
            );
            if (callbacks) {
              await this.actionExecutor.executeMessage(
                dataMessage.bindingKey,
                dataMessage.payload,
                callbacks
              );
            }
            break;
          }
          case 'ack': {
            const ackMessage = message as AckMessage;
            this.messagePublisher.handleMessageAck(
              ackMessage.messageId,
              ackMessage.status === 'success'
                ? null
                : new Error(ackMessage.error || 'Message failed')
            );
            break;
          }
          case 'nack': {
            const nackMessage = message as NackMessage;
            this.messagePublisher.handleMessageAck(
              nackMessage.messageId,
              new Error(nackMessage.error || 'Message rejected by server')
            );
            break;
          }
          default: {
            this.logger.warn(
              'Unknown message action received:',
              (message as any).action
            );
            break;
          }
        }
      } catch (e) {
        this.logger.error('Error parsing message from server:', e);
      }
    });
  }

  /**
   * Sets the log level for this WebMQ client instance.
   * @param level The log level to set ('silent', 'error', 'warn', 'info', 'debug')
   */
  public setLogLevel(level: LogLevel): void {
    this.logger.setLogLevel(level);

    // Update child loggers
    this.connectionManager = new ConnectionManager(
      this,
      this.logger.child('ConnectionManager')
    );
    this.sessionManager = new SessionManager(
      this.connectionManager,
      this.logger.child('SessionManager')
    );
    this.actionExecutor = new ActionExecutor(
      this,
      this.logger.child('ActionExecutor')
    );
    this.messagePublisher = new MessagePublisher(
      this.connectionManager,
      this.logger.child('MessagePublisher')
    );
    this.subscriptionManager = new SubscriptionManager(
      this.connectionManager,
      this.logger.child('SubscriptionManager')
    );
  }

  /**
   * Configures the WebSocket server URL.
   * @param url The WebSocket URL (e.g., 'ws://localhost:8080')
   * @param options Configuration options
   */
  public setup(url: string, options: WebMQClientOptions = {}) {
    this.connectionManager.setUrl(url);

    if (options.maxReconnectAttempts !== undefined) {
      this.connectionManager.setMaxReconnectAttempts(
        options.maxReconnectAttempts
      );
    }
    if (options.maxQueueSize !== undefined) {
      this.messagePublisher.setMaxQueueSize(options.maxQueueSize);
    }
    if (options.messageTimeout !== undefined) {
      this.messagePublisher.setMessageTimeout(options.messageTimeout);
    }
    if (options.hooks) {
      this.actionExecutor.setHooks(options.hooks);
    }
  }

  /**
   * Explicitly initiates the connection to the server.
   * Optional: If not called, connection is made on the first `publish` or `listen`.
   */
  public connect(): Promise<void> {
    return this.connectionManager.connect();
  }

  private async _ensureConnected(): Promise<void> {
    if (!this.connectionManager.isReady()) {
      try {
        await this.connectionManager.connect();
      } catch (error) {
        // Don't re-throw the error since we're handling retries
        return;
      }
    }
  }

  /**
   * Sends a message to the backend and waits for acknowledgment.
   * @param routingKey The key to route the message by.
   * @param payload The data to publish.
   * @returns Promise that resolves when server confirms delivery or rejects on failure/timeout
   */
  public async publish(routingKey: string, payload: any): Promise<void> {
    const sendAction = async (
      finalRoutingKey: string,
      finalPayload: any
    ): Promise<void> => {
      if (this.connectionManager.isReady()) {
        return this.messagePublisher.publish(finalRoutingKey, finalPayload);
      } else {
        // Queue message and try to connect
        const publishPromise = this.messagePublisher.publish(
          finalRoutingKey,
          finalPayload
        );
        this._ensureConnected().catch(() => {
          // Connection failed, but message is already queued
        });
        return publishPromise;
      }
    };

    await this.actionExecutor.executePublish(routingKey, payload, sendAction);
  }

  /**
   * Listens for messages matching a binding pattern.
   * @param bindingKey The pattern to listen for (e.g., 'chat.message', 'user.*').
   * @param callback The function to call with the message payload.
   */
  public async listen(
    bindingKey: string,
    callback: MessageCallback
  ): Promise<void> {
    const listenAction = async (
      finalBindingKey: string,
      finalCallback: MessageCallback
    ): Promise<void> => {
      await this.subscriptionManager.listen(finalBindingKey, finalCallback);

      // Trigger connection if not ready (don't wait for it)
      if (!this.connectionManager.isReady()) {
        this._ensureConnected().catch(() => {
          // Connection failed, but listener is stored and will be sent on reconnect
        });
      }
    };

    await this.actionExecutor.executeListen(bindingKey, callback, listenAction);
  }

  /**
   * Stops listening for messages.
   * @param bindingKey The pattern to stop listening for.
   * @param callback The specific callback to remove.
   */
  public async unlisten(
    bindingKey: string,
    callback: MessageCallback
  ): Promise<void> {
    await this.subscriptionManager.unlisten(bindingKey, callback);
  }

  /**
   * Disconnects from the WebSocket server.
   * @param options Configuration for handling active listeners
   */
  public disconnect(options: DisconnectOptions = {}): void {
    const { onActiveListeners = 'ignore' } = options;

    // Validate option first
    if (!['ignore', 'throw', 'clear'].includes(onActiveListeners)) {
      throw new Error(
        `Invalid onActiveListeners option: ${onActiveListeners}. Must be 'ignore', 'throw', or 'clear'.`
      );
    }

    if (this.subscriptionManager.size() > 0) {
      switch (onActiveListeners) {
        case 'ignore':
          return; // Do nothing, keep connection alive

        case 'throw':
          throw new Error(
            `Cannot disconnect: ${this.subscriptionManager.size()} active listeners. Use onActiveListeners: 'clear' or unlisten() first.`
          );

        case 'clear':
          this.subscriptionManager.clear(); // Remove all listeners
          break;
      }
    }

    // Actually disconnect
    this.connectionManager.close();
  }

  /**
   * Returns the current number of queued messages.
   */
  public getQueueSize(): number {
    return this.messagePublisher.getQueueSize();
  }

  /**
   * Clears all queued messages.
   */
  public clearQueue(): void {
    this.messagePublisher.clearQueue();
  }

  /**
   * Get session ID for debugging purposes
   */
  public getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  // --- Testing Support Methods ---
  // These methods expose internal state for testing purposes

  /** Get the underlying WebSocket connection (for testing) */
  public _getWebSocket(): WebSocket | null {
    return this.connectionManager.getConnection();
  }

  /** Get connection state (for testing) */
  public _getConnectionState(): { isConnected: boolean } {
    return { isConnected: this.connectionManager.isReady() };
  }

  /** Get number of listeners for a binding key (for testing) */
  public _getListenerCount(bindingKey: string): number {
    const callbacks = this.subscriptionManager.getCallbacks(bindingKey);
    return callbacks ? callbacks.length : 0;
  }

  /** Get total number of binding keys being listened to (for testing) */
  public _getListenerSize(): number {
    return this.subscriptionManager.size();
  }
}

// --- Hybrid Singleton/Instance Pattern ---

const defaultClient = new WebMQClient();

// Core methods exposed directly for convenience
export const setup = defaultClient.setup.bind(defaultClient);
export const connect = defaultClient.connect.bind(defaultClient);
export const publish = defaultClient.publish.bind(defaultClient);
export const listen = defaultClient.listen.bind(defaultClient);
export const unlisten = defaultClient.unlisten.bind(defaultClient);
export const disconnect = defaultClient.disconnect.bind(defaultClient);

// Export the defaultClient for advanced features (queue monitoring, logging, events)
// Use: client.getQueueSize(), client.clearQueue(), client.setLogLevel(), client.on('event', ...)
export { defaultClient as client };
