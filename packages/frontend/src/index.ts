import WebMQClientWebSocket from './websocket';

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
export class WebMQClient {
  public logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug' = 'info';

  private ws: WebMQClientWebSocket | null = null;
  private messageListeners = new Map<string, Set<(payload: any) => void>>();

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

  /**
   * Configures the WebSocket server URL.
   * @param url The WebSocket URL (e.g., 'ws://localhost:8080')
   */
  setup(url: string): void {
    this._log('info', `Setting up WebMQ client for: ${url}`);
    this.ws = new WebMQClientWebSocket(url);
    this.ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);

        // Only handle data messages (not ack/nack which are handled by WebSocket layer)
        if (message.action === 'message') {
          this._log('debug', `Received message for binding '${message.bindingKey}'`);
          const callbacks = this.messageListeners.get(message.bindingKey);
          if (callbacks) {
            this._log('debug', `Delivering message to ${callbacks.size} callback(s)`);
            callbacks.forEach(callback => callback(message.payload));
          } else {
            this._log('warn', `No callbacks registered for binding '${message.bindingKey}'`);
          }
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
    this._log('info', `Publishing message to routing key: ${routingKey}`);
    try {
      await this.ws.send({ action: 'publish', routingKey, payload });
      this._log('debug', `Message published successfully to: ${routingKey}`);
    } catch (error: any) {
      this._log('error', `Failed to publish message to '${routingKey}': ${error.message}`);
      throw error;
    }
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

    // Add to listeners map
    const existing = this.messageListeners.get(bindingKey);
    if (existing) {
      existing.add(callback);
      this._log('debug', `Added callback to existing binding '${bindingKey}' (${existing.size} total callbacks)`);
    } else {
      this.messageListeners.set(bindingKey, new Set([callback]));
      this._log('info', `Creating new binding for pattern: ${bindingKey}`);
      try {
        // Send listen message for the first listener on this key
        await this.ws.send({ action: 'listen', bindingKey });
        this._log('debug', `Successfully subscribed to binding: ${bindingKey}`);
      } catch (error: any) {
        this._log('error', `Failed to subscribe to binding '${bindingKey}': ${error.message}`);
        // Clean up the listener map since subscription failed
        this.messageListeners.delete(bindingKey);
        throw error;
      }
    }

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

    const callbacks = this.messageListeners.get(bindingKey);
    if (!callbacks) {
      this._log('warn', `Attempted to unlisten from non-existent binding: ${bindingKey}`);
      return;
    }

    callbacks.delete(callback);
    this._log('debug', `Removed callback from binding '${bindingKey}' (${callbacks.size} remaining)`);

    if (callbacks.size === 0) {
      this.messageListeners.delete(bindingKey);
      this._log('info', `Unsubscribing from binding: ${bindingKey}`);
      try {
        // Send unlisten message when no more listeners
        await this.ws.send({ action: 'unlisten', bindingKey });
        this._log('debug', `Successfully unsubscribed from binding: ${bindingKey}`);
      } catch (error: any) {
        this._log('warn', `Failed to unsubscribe from binding '${bindingKey}': ${error.message}`);
        // Note: We don't throw here since the local state is already cleaned up
      }
    }
  }
}

// --- Singleton Pattern for Convenience ---

const defaultClient = new WebMQClient();

// Core methods exposed directly for convenience
export const setup = defaultClient.setup.bind(defaultClient);
export const publish = defaultClient.publish.bind(defaultClient);
export const listen = defaultClient.listen.bind(defaultClient);
export const unlisten = defaultClient.unlisten.bind(defaultClient);

// Export the defaultClient for direct access if needed
export { defaultClient as client };
