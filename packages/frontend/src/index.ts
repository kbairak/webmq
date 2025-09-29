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
  private ws: WebMQClientWebSocket | null = null;
  private messageListeners = new Map<string, Set<(payload: any) => void>>();

  /**
   * Configures the WebSocket server URL.
   * @param url The WebSocket URL (e.g., 'ws://localhost:8080')
   */
  setup(url: string): void {
    this.ws = new WebMQClientWebSocket(url);
    this.ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);

        // Only handle data messages (not ack/nack which are handled by WebSocket layer)
        if (message.action === 'message') {
          const callbacks = this.messageListeners.get(message.bindingKey);
          if (callbacks) {
            callbacks.forEach(callback => callback(message.payload));
          }
        }
      } catch (e) {
        // Ignore invalid JSON messages
      }
    });
  }

  /**
   * Sends a message to the backend and waits for acknowledgment.
   * @param routingKey The key to route the message by.
   * @param payload The data to publish.
   * @returns Promise that resolves when server confirms delivery or rejects on failure/timeout
   */
  async publish(routingKey: string, payload: any): Promise<void> {
    if (!this.ws) {
      throw new Error('Call setup() first');
    }
    return this.ws.send({ action: 'publish', routingKey, payload });
  }

  /**
   * Listens for messages matching a binding pattern.
   * @param bindingKey The pattern to listen for (e.g., 'chat.message', 'user.*').
   * @param callback The function to call with the message payload.
   */
  async listen(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    if (!this.ws) {
      throw new Error('Call setup() first');
    }

    // Add to listeners map
    const existing = this.messageListeners.get(bindingKey);
    if (existing) {
      existing.add(callback);
    } else {
      this.messageListeners.set(bindingKey, new Set([callback]));
      // Send listen message for the first listener on this key
      await this.ws.send({ action: 'listen', bindingKey });
    }

  }

  /**
   * Stops listening for messages.
   * @param bindingKey The pattern to stop listening for.
   * @param callback The specific callback to remove.
   */
  async unlisten(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    if (!this.ws) {
      throw new Error('Call setup() first');
    }

    const callbacks = this.messageListeners.get(bindingKey);
    if (!callbacks) return;

    callbacks.delete(callback);

    if (callbacks.size === 0) {
      this.messageListeners.delete(bindingKey);
      // Send unlisten message when no more listeners
      await this.ws.send({ action: 'unlisten', bindingKey });
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
