import { EventEmitter } from 'eventemitter3';
import { v4 as uuid } from 'uuid';
import { HookFunction, runWithHooks } from './hooks';

function matchesPattern(routingKey: string, bindingKey: string): boolean {
  const regexPattern = bindingKey
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*/g, '[^.]+') // * matches one or more non-dots
    .replace(/#/g, '.*');    // # matches zero or more of any character
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(routingKey);
}

export type WebMQClientHooks = {
  pre?: HookFunction[];
  onIdentify?: HookFunction[];
  onPublish?: HookFunction[];
  onListen?: HookFunction[];
  onUnlisten?: HookFunction[];
  onMessage?: HookFunction[];
};

export interface WebMQClientOptions {
  url?: string;
  hooks?: WebMQClientHooks;
  ackTimeoutDelay?: number;
  reconnectionDelay?: number;
  maxReconnectionAttempts?: number;
};

interface Message {
  action: string;
  sessionId?: string;
  bindingKey?: string;
  routingKey?: string;
  payload?: string;
  [key: string]: any;
}

export class WebMQClient extends EventEmitter {
  private _url: string = '';
  private _hooks: {
    pre: HookFunction[];
    onPublish: HookFunction[];
    onIdentify: HookFunction[];
    onListen: HookFunction[];
    onUnlisten: HookFunction[];
    onMessage: HookFunction[];
  } = { pre: [], onIdentify: [], onPublish: [], onListen: [], onUnlisten: [], onMessage: [] };
  private _ackTimeoutDelay = 5000;
  private _reconnectionDelay = 1000;
  private _maxReconnectionAttempts = 5;

  private _context: { sessionId: string;[key: string]: any; } = { sessionId: '' };

  private _connectionPromise: Promise<void> | null = null;
  private _isReconnecting = false;
  private _shouldReconnect = true;
  private _ws: WebSocket | null = null;
  private _pendingMessages = new Map<
    string, { resolve: Function; reject: Function; timeout: any; }
  >();
  private _messageListeners = new Map<string, Set<(payload: any) => void>>();

  public logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug' = 'info';
  private _cachedError: Event | null = null;

  constructor(options: WebMQClientOptions) {
    super();
    this.setup(options);
  }

  public setup(options: WebMQClientOptions): void {
    if (options.url) this._url = options.url;
    Object.assign(this._hooks, options.hooks || {});
    if (options.ackTimeoutDelay) this._ackTimeoutDelay = options.ackTimeoutDelay;
    if (options.reconnectionDelay) this._reconnectionDelay = options.reconnectionDelay;
    if (options.maxReconnectionAttempts) this._maxReconnectionAttempts = options.maxReconnectionAttempts;
    if (typeof window !== 'undefined' && window.sessionStorage) {
      this._context.sessionId = sessionStorage.getItem('webmq_session_id') || '';
      if (!this._context.sessionId) {
        this._context.sessionId = uuid();
        sessionStorage.setItem('webmq_session_id', this._context.sessionId);
      }
    } else {
      this._context.sessionId = uuid();
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this._log('info', 'Page unloading, closing WebSocket connection');
        this._ws?.close();
        this._shouldReconnect = false
        this._connectionPromise = Promise.reject(new Error('Page unloading'));
        this._connectionPromise.catch(() => { });
      });
    }
  }

  private _ensureConnection(): Promise<void> {
    if (!this._connectionPromise) {
      this._connectionPromise = new Promise((resolve, reject) => {
        this._log('debug', `Establishing WebSocket connection to ${this._url}`);
        this._ws = new WebSocket(this._url);

        this._ws.addEventListener('open', async () => {
          this._log('debug', `WebSocket connection to ${this._url} established with session ID ${this._context.sessionId}`);
          try {
            this._log('debug', `Identifying with session ID ${this._context.sessionId}`);
            const hookMessage: Message = { action: 'identify', sessionId: this._context.sessionId };
            await runWithHooks(
              this._context,
              [...this._hooks.pre, ...this._hooks.onIdentify, (_1, _2, msg: Message) => this._send(msg)],
              hookMessage,
            );
            this._log('info', `WebSocket connection to ${this._url} established and identified with session ID ${this._context.sessionId}`);
            this.emit('connected');
            this._cachedError = null;
            resolve();
          } catch (e: any) {
            reject(new Error(`Identify error: ${e.message}`));
          }
        });

        this._ws.addEventListener('message', (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (e: any) {
            this._log('warn', `Received invalid JSON message: ${e.message}`);
            return;
          }
          if (['ack', 'nack'].includes(message.action)) {
            const pending = this._pendingMessages.get(message.messageId);
            if (pending) {
              clearTimeout(pending.timeout);
              if (message.action === 'ack') {
                this._log('debug', `Received ack for messageId ${message.messageId}`);
                pending.resolve();
              } else if (message.action === 'nack') {
                this._log('warn', `Received nack for messageId ${message.messageId}: ${message.error}`);
                pending.reject(new Error(message.error || 'Message rejected'));
              }
              this._pendingMessages.delete(message.messageId);
            }
          } else if (message.action === 'message') {
            const matchingBindings = [...this._messageListeners.keys()].filter(
              (bindingKey) => matchesPattern(message.routingKey, bindingKey)
            );
            this._log('debug', `Received message for routing key ${message.routingKey}, matching bindings: ${matchingBindings.join(', ')}`);
            matchingBindings.forEach((bindingKey: string) => {
              (this._messageListeners.get(bindingKey) || []).forEach((callback) => {
                const hookMessage: Message = {
                  action: 'message',
                  bindingKey,
                  routingKey: message.routingKey,
                  payload: message.payload,
                };
                runWithHooks(
                  this._context,
                  [...this._hooks.pre, ...this._hooks.onMessage, async (_1, _2, msg: Message) => callback(msg.payload)],
                  hookMessage,
                  event,
                )
              });
            });
          } else {
            this._log('warn', `Received message with unknown action: ${message.action}`);
          }
        });

        this._ws.addEventListener('close', async () => {
          if (!this._shouldReconnect || this._isReconnecting) {
            if (!this._shouldReconnect) {
              if (this._cachedError) {
                this.emit('error', this._cachedError);
                this._cachedError = null;
              }
              this.emit('disconnected');
            }
            reject();  // Only matters if closed before open
            return;
          }
          this._log('warn', `WebSocket connection to ${this._url} closed, attempting to reconnect...`);
          this._isReconnecting = true;
          for (let attempt = 0; attempt < this._maxReconnectionAttempts; attempt++) {
            this.emit('reconnecting', attempt + 1);
            this._log('debug', `Reconnection attempt ${attempt + 1} of ${this._maxReconnectionAttempts}`);
            const delay = attempt === 0 ? 0 : Math.pow(2, attempt - 1) * this._reconnectionDelay;
            this._connectionPromise = null;
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            try {
              await this._ensureConnection();
              this._log('info', 'Reconnected successfully');
              this._isReconnecting = false;
              this._cachedError = null;
              resolve();
              return;
            } catch (e) { }
          }
          this._isReconnecting = false;
          this.emit('disconnected');
          if (this._cachedError) {
            this.emit('error', this._cachedError);
            this._cachedError = null;
          }
          reject(new Error('Connection lost and reconnection attempts failed'));
        });

        this._ws.addEventListener('error', (event) => {
          if (!this._cachedError) {
            this._cachedError = event;
          }
        });
      });
    }
    return this._connectionPromise;
  }

  private async _send(data: any): Promise<void> {
    // `_send` never get called if we we haven't confirmed that a websocket connection is open
    return new Promise((resolve, reject) => {
      const messageId = uuid();
      let stringified;
      try {
        stringified = JSON.stringify({ ...data, messageId });
      } catch (e: any) {
        reject(new Error(`Failed to serialize message: ${e.message}`));
        return;
      }
      const timeout = setTimeout(() => {
        this._pendingMessages.delete(messageId);
        reject(new Error('Message timeout'));
      }, this._ackTimeoutDelay);
      this._pendingMessages.set(messageId, { resolve, reject, timeout });
      this._log('debug', `Sending message with ID ${messageId}, ${this._pendingMessages.size} pending messages`);
      this._ws!.send(stringified);
    });
  }

  public async publish(routingKey: string, payload: any): Promise<void> {
    this._log('info', `Publishing message to routing key: ${routingKey}`);
    try {
      await this._ensureConnection();
      const hookMessage: Message = { action: 'publish', routingKey, payload }
      await runWithHooks(
        this._context,
        [...this._hooks.pre, ...this._hooks.onPublish, (_1, _2, msg: Message) => this._send(msg)],
        hookMessage,
      );
      this._log('debug', `Published message to routing key: ${routingKey}`);
    } catch (e: any) {
      this._log('error', `Failed to publish message to '${routingKey}': ${e.message}`);
      throw e;
    }
  }

  public async listen(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    const hookMessage: Message = { action: 'listen', bindingKey };
    await runWithHooks(
      this._context,
      [
        ...this._hooks.pre,
        ...this._hooks.onListen,
        async (_context, _next, msg) => {
          this._log('info', `Listening to binding key: ${bindingKey}`);
          try {
            let callbacks = this._messageListeners.get(bindingKey);
            if (!callbacks) {
              callbacks = new Set();
              this._messageListeners.set(bindingKey, callbacks);
            }
            if (!callbacks.has(callback)) {
              callbacks.add(callback);
              if (callbacks.size === 1) {
                await this._ensureConnection();
                await this._send(msg);
              }
            }
          } catch (e: any) {
            this._log('error', `Failed to listen to '${bindingKey}': ${e.message}`);
            throw e;
          }
        },
      ],
      hookMessage,
    );
  }

  public async unlisten(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    const hookMessage: Message = { action: 'unlisten', bindingKey };
    await runWithHooks(
      this._context,
      [
        ...this._hooks.pre,
        ...this._hooks.onUnlisten,
        async (_context, _next, msg: Message) => {
          this._log('info', `Unlistening from binding key: ${bindingKey}`);
          try {
            const callbacks = this._messageListeners.get(bindingKey);
            if (callbacks && callbacks.has(callback)) {
              callbacks.delete(callback);
              if (callbacks.size === 0) {
                this._messageListeners.delete(bindingKey);
                this._log('debug', `No more listeners for binding key: ${bindingKey}, sending unlisten request`);
                await this._ensureConnection();
                await this._send(msg)
              }
            }
          } catch (e: any) {
            this._log('error', `Failed to unlisten from '${bindingKey}': ${e.message}`);
            throw e;
          }
        },
      ],
      hookMessage,
    );
  }

  public close() {
    if (this._ws) {
      this._log('info', 'Closing WebSocket connection');
      this._shouldReconnect = false;
      this._ws.close();
      this._ws = null;
      this._connectionPromise = Promise.reject(new Error('Connection closed by client'));
      this._connectionPromise.catch(() => { }); // Suppress unhandled rejection warning
    }
  }

  private _log(level: 'error' | 'warn' | 'info' | 'debug', message: string): void {
    if (this.logLevel === 'silent') return;

    const levels = ['error', 'warn', 'info', 'debug'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (messageLevelIndex <= currentLevelIndex) {
      switch (level) {
        case 'error':
          console.error(`[WebMQ Frontend ERROR] ${message}`);
          break;
        case 'warn':
          console.warn(`[WebMQ Frontend WARN] ${message}`);
          break;
        case 'info':
          console.log(`[WebMQ Frontend INFO] ${message}`);
          break;
        case 'debug':
          console.debug(`[WebMQ Frontend DEBUG] ${message}`);
          break;
      }
    }
  }
}

// --- Singleton Pattern for Convenience ---

export const webMQClient = new WebMQClient({});

// Core methods exposed directly for convenience
export const setup = webMQClient.setup.bind(webMQClient);
export const publish = webMQClient.publish.bind(webMQClient);
export const listen = webMQClient.listen.bind(webMQClient);
export const unlisten = webMQClient.unlisten.bind(webMQClient);
export const close = webMQClient.close.bind(webMQClient);
