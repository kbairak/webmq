import WebMQClientWebSocket from './websocket';
import { HookFunction, runWithHooks } from './hooks';
import { EventEmitter } from 'eventemitter3';

export type FrontendMessage = {
  action: 'publish' | 'listen' | 'unlisten' | 'message';
  routingKey?: string;
  payload?: any;
  bindingKey?: string;
  callback?: (payload: any) => void;
};

export type WebMQClientHooks = {
  pre?: HookFunction<FrontendMessage>[];
  onPublish?: HookFunction<FrontendMessage>[];
  onListen?: HookFunction<FrontendMessage>[];
  onUnlisten?: HookFunction<FrontendMessage>[];
  onMessage?: HookFunction<FrontendMessage>[];
};

function matchesPattern(routingKey: string, bindingKey: string): boolean {
  const regexPattern = bindingKey
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*/g, '[^.]+') // * matches one or more non-dots
    .replace(/#/g, '.*');    // # matches zero or more of any character
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(routingKey);
}

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
  private _logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug' = 'info';

  private ws: WebMQClientWebSocket | null = null;
  private messageListeners = new Map<string, Set<(payload: any) => void>>();
  private _context: any = {};
  private _hooks = {
    pre: [] as HookFunction<FrontendMessage>[],
    onPublish: [] as HookFunction<FrontendMessage>[],
    onListen: [] as HookFunction<FrontendMessage>[],
    onUnlisten: [] as HookFunction<FrontendMessage>[],
    onMessage: [] as HookFunction<FrontendMessage>[]
  };

  constructor(url?: string, hooks?: WebMQClientHooks) {
    super();
    this.setup(url || '', hooks);
  }

  /**
   * Configures the WebSocket server URL.
   * @param url The WebSocket URL (e.g., 'ws://localhost:8080')
   * @param hooks Optional configuration including hooks
   */
  setup(url: string, hooks?: WebMQClientHooks): void {
    if (hooks) {
      this._hooks = {
        pre: hooks.pre || [],
        onPublish: hooks.onPublish || [],
        onListen: hooks.onListen || [],
        onUnlisten: hooks.onUnlisten || [],
        onMessage: hooks.onMessage || []
      };
    }

    // Skip WebSocket setup if no URL provided (for singleton lazy initialization)
    if (!url) {
      return;
    }

    // Close old WebSocket before creating new one to prevent duplicate consumers
    if (this.ws) {
      this._log('debug', 'Closing existing WebSocket before creating new one');
      this.ws.close();
    }

    this._log('info', `Setting up WebMQ client for: ${url}`);
    this.ws = new WebMQClientWebSocket(url, this.logLevel);

    // Forward WebSocket events
    this.ws.addEventListener('open', () => {
      this.emit('connected');
    });

    this.ws.addEventListener('reconnecting', (event: any) => {
      this.emit('reconnecting', event);
    });

    this.ws.addEventListener('close', () => {
      this.emit('disconnected');
    });

    this.ws.addEventListener('error', (event: Event) => {
      this.emit('error', event);
    });

    // Disable auto-reconnect when page is unloading to prevent zombie connections
    if (typeof window !== 'undefined') {
      const disableReconnectOnUnload = () => {
        if (this.ws) {
          (this.ws as any)._shouldReconnect = false;
          this._log('debug', 'Disabled auto-reconnect due to page unload');
        }
      };
      window.addEventListener('beforeunload', disableReconnectOnUnload);
    }

    this.ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);

        // Only handle data messages (not ack/nack which are handled by WebSocket layer)
        if (message.action === 'message') {
          const routingKey = message.routingKey;

          // Find all active bindings that match this routing key
          const matchingBindings = [...this.messageListeners.keys()]
            .filter(bindingKey => matchesPattern(routingKey, bindingKey));

          this._log('debug', `Received message with routingKey '${routingKey}', matches ${matchingBindings.length} binding(s): [${matchingBindings.join(', ')}]`);

          matchingBindings.forEach(async (bindingKey: string) => {
            const frontendMessage: FrontendMessage = {
              action: 'message',
              bindingKey,
              routingKey,
              payload: message.payload
            };

            try {
              await runWithHooks(
                this._context,
                [...this._hooks.pre, ...this._hooks.onMessage],
                frontendMessage,
                async () => {
                  const callbacks = this.messageListeners.get(bindingKey);
                  if (callbacks) {
                    this._log('debug', `Delivering message to ${callbacks.size} callback(s) for binding '${bindingKey}'`);
                    callbacks.forEach(callback => callback(frontendMessage.payload));
                  }
                }
              );
            } catch (error: any) {
              this._log('error', `Hook error for binding '${bindingKey}': ${error.message}`);
              // Hook error prevents message delivery
            }
          });
        }
      } catch (e) {
        this._log('warn', `Failed to parse message: ${e}`);
        // Ignore invalid JSON messages
      }
    });
    this._log('info', 'WebMQ client setup complete');
  }

  /**
   * Sends a message to the backend and waits for acknowledgment.
   * @param routingKey The key to route the message by.
   * @param payload The data to publish.
   * @returns Promise that resolves when server confirms delivery or rejects on failure/timeout
   */
  async publish(routingKey: string, payload: any): Promise<void> {
    if (!this.ws) {
      this._log('error', 'Attempted to publish before calling setup()');
      throw new Error('Call setup() first');
    }

    const message: FrontendMessage = { action: 'publish', routingKey, payload };

    await runWithHooks(
      this._context,
      [...this._hooks.pre, ...this._hooks.onPublish],
      message,
      async () => {
        this._log('info', `Publishing message to routing key: ${message.routingKey}`);
        try {
          await this.ws!.send({ action: 'publish', routingKey: message.routingKey, payload: message.payload });
          this._log('debug', `Message published successfully to: ${message.routingKey}`);
        } catch (error: any) {
          this._log('error', `Failed to publish message to '${message.routingKey}': ${error.message}`);
          throw error;
        }
      }
    );
  }

  /**
   * Listens for messages matching a binding pattern.
   * @param bindingKey The pattern to listen for (e.g., 'chat.message', 'user.*').
   * @param callback The function to call with the message payload.
   */
  async listen(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    if (!this.ws) {
      this._log('error', 'Attempted to listen before calling setup()');
      throw new Error('Call setup() first');
    }

    const message: FrontendMessage = { action: 'listen', bindingKey, callback };

    await runWithHooks(
      this._context,
      [...this._hooks.pre, ...this._hooks.onListen],
      message,
      async () => {
        // Add to listeners map
        const existing = this.messageListeners.get(message.bindingKey!);
        if (existing) {
          existing.add(callback);
          this._log('debug', `Added callback to existing binding '${message.bindingKey}' (${existing.size} total callbacks)`);
        } else {
          this.messageListeners.set(message.bindingKey!, new Set([callback]));
          this._log('info', `Creating new binding for pattern: ${message.bindingKey}`);
          try {
            // Send listen message for the first listener on this key
            await this.ws!.send({ action: 'listen', bindingKey: message.bindingKey });
            this._log('debug', `Successfully subscribed to binding: ${message.bindingKey}`);
          } catch (error: any) {
            this._log('error', `Failed to subscribe to binding '${message.bindingKey}': ${error.message}`);
            // Clean up the listener map since subscription failed
            this.messageListeners.delete(message.bindingKey!);
            throw error;
          }
        }
      }
    );
  }

  /**
   * Stops listening for messages.
   * @param bindingKey The pattern to stop listening for.
   * @param callback The specific callback to remove.
   */
  async unlisten(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    if (!this.ws) {
      this._log('error', 'Attempted to unlisten before calling setup()');
      throw new Error('Call setup() first');
    }

    const message: FrontendMessage = { action: 'unlisten', bindingKey, callback };

    await runWithHooks(
      this._context,
      [...this._hooks.pre, ...this._hooks.onUnlisten],
      message,
      async () => {
        const callbacks = this.messageListeners.get(message.bindingKey!);
        if (!callbacks) {
          this._log('warn', `Attempted to unlisten from non-existent binding: ${message.bindingKey}`);
          return;
        }

        callbacks.delete(callback);
        this._log('debug', `Removed callback from binding '${message.bindingKey}' (${callbacks.size} remaining)`);

        if (callbacks.size === 0) {
          this.messageListeners.delete(message.bindingKey!);
          this._log('info', `Unsubscribing from binding: ${message.bindingKey}`);
          try {
            // Send unlisten message when no more listeners
            await this.ws!.send({ action: 'unlisten', bindingKey: message.bindingKey });
            this._log('debug', `Successfully unsubscribed from binding: ${message.bindingKey}`);
          } catch (error: any) {
            this._log('warn', `Failed to unsubscribe from binding '${message.bindingKey}': ${error.message}`);
            // Note: We don't throw here since the local state is already cleaned up
          }
        }
      }
    );
  }

  public get logLevel(): 'silent' | 'error' | 'warn' | 'info' | 'debug' {
    return this._logLevel;
  }

  public set logLevel(level: 'silent' | 'error' | 'warn' | 'info' | 'debug') {
    this._logLevel = level;
    if (this.ws) {
      this.ws.logLevel = level;
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

export const webMQClient = new WebMQClient();

// Core methods exposed directly for convenience
export const setup = webMQClient.setup.bind(webMQClient);
export const publish = webMQClient.publish.bind(webMQClient);
export const listen = webMQClient.listen.bind(webMQClient);
export const unlisten = webMQClient.unlisten.bind(webMQClient);
