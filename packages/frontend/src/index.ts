// --- Type Definitions ---
type MessageCallback = (payload: any) => void;

// --- Class Implementation ---

/**
 * A client for interacting with a WebMQ backend.
 */
export class WebMQClient {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private connectionPromise: Promise<void> | null = null;
  private isConnected = false;

  private listeners: Map<string, MessageCallback[]> = new Map();

  /**
   * Configures the WebSocket server URL.
   * @param url The WebSocket URL (e.g., 'ws://localhost:8080')
   */
  public setup(url: string) {
    this.url = url;
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

        this.ws.onopen = () => {
          console.log('WebMQ client connected.');
          this.isConnected = true;
          // Resubscribe to all existing listeners on reconnection
          for (const bindingKey of this.listeners.keys()) {
            this.ws?.send(JSON.stringify({ action: 'listen', bindingKey }));
          }
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'message' && message.bindingKey) {
              const callbacks = this.listeners.get(message.bindingKey);
              if (callbacks) {
                callbacks.forEach(cb => cb(message.payload));
              }
            }
          } catch (e) {
            console.error('Error parsing message from server:', e);
          }
        };

        this.ws.onerror = (err) => {
          console.error('WebMQ client error:', err);
          if (!this.isConnected) {
            reject(new Error('WebSocket connection failed.'));
          }
        };

        this.ws.onclose = () => {
          console.log('WebMQ client disconnected.');
          this.isConnected = false;
          this.ws = null;
          this.connectionPromise = null;
        };
      });
    }
    return this.connectionPromise;
  }

  private async _ensureConnected(): Promise<void> {
    if (!this.isConnected && !this.connectionPromise) {
      await this.connect();
    }
    return this.connectionPromise!;
  }

  /**
   * Sends a message to the backend.
   * @param routingKey The key to route the message by.
   * @param payload The data to send.
   */
  public async emit(routingKey: string, payload: any): Promise<void> {
    await this._ensureConnected();
    this.ws?.send(JSON.stringify({ action: 'emit', routingKey, payload }));
  }

  /**
   * Listens for messages matching a binding pattern.
   * @param bindingKey The pattern to listen for (e.g., 'chat.message', 'user.*').
   * @param callback The function to call with the message payload.
   */
  public async listen(bindingKey: string, callback: MessageCallback): Promise<void> {
    await this._ensureConnected();
    const existing = this.listeners.get(bindingKey);
    if (existing) {
      existing.push(callback);
    } else {
      this.listeners.set(bindingKey, [callback]);
      this.ws?.send(JSON.stringify({ action: 'listen', bindingKey }));
    }
  }

  /**
   * Stops listening for messages.
   * @param bindingKey The pattern to stop listening for.
   * @param callback The specific callback to remove.
   */
  public async unlisten(bindingKey: string, callback: MessageCallback): Promise<void> {
    const callbacks = this.listeners.get(bindingKey);
    if (!callbacks) return;

    const filteredCallbacks = callbacks.filter(cb => cb !== callback);

    if (filteredCallbacks.length > 0) {
      this.listeners.set(bindingKey, filteredCallbacks);
    } else {
      this.listeners.delete(bindingKey);
      await this._ensureConnected();
      this.ws?.send(JSON.stringify({ action: 'unlisten', bindingKey }));
    }
  }
}

// --- Hybrid Singleton/Instance Pattern ---

const defaultClient = new WebMQClient();

export const setup = defaultClient.setup.bind(defaultClient);
export const connect = defaultClient.connect.bind(defaultClient);
export const emit = defaultClient.emit.bind(defaultClient);
export const listen = defaultClient.listen.bind(defaultClient);
export const unlisten = defaultClient.unlisten.bind(defaultClient);
