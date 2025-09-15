// src/index.ts
var WebMQClient = class {
  constructor() {
    this.ws = null;
    this.url = null;
    this.connectionPromise = null;
    this.isConnected = false;
    this.listeners = /* @__PURE__ */ new Map();
  }
  /**
   * Configures the WebSocket server URL.
   * @param url The WebSocket URL (e.g., 'ws://localhost:8080')
   */
  setup(url) {
    this.url = url;
  }
  /**
   * Explicitly initiates the connection to the server.
   * Optional: If not called, connection is made on the first `emit` or `listen`.
   */
  connect() {
    if (!this.connectionPromise) {
      if (!this.url) {
        return Promise.reject(new Error("URL not set. Call setup(url) first."));
      }
      this.connectionPromise = new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.url);
        this.ws.addEventListener("open", () => {
          console.log("WebMQ client connected.");
          this.isConnected = true;
          for (const bindingKey of this.listeners.keys()) {
            this.ws?.send(JSON.stringify({ action: "listen", bindingKey }));
          }
          resolve();
        });
        this.ws.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "message" && message.bindingKey) {
              const callbacks = this.listeners.get(message.bindingKey);
              if (callbacks) {
                callbacks.forEach((cb) => cb(message.payload));
              }
            }
          } catch (e) {
            console.error("Error parsing message from server:", e);
          }
        });
        this.ws.addEventListener("error", (err) => {
          console.error("WebMQ client error:", err);
          if (!this.isConnected) {
            reject(new Error("WebSocket connection failed."));
          }
        });
        this.ws.addEventListener("close", () => {
          console.log("WebMQ client disconnected.");
          this.isConnected = false;
          this.ws = null;
          this.connectionPromise = null;
        });
      });
    }
    return this.connectionPromise;
  }
  async _ensureConnected() {
    if (!this.isConnected && !this.connectionPromise) {
      await this.connect();
    }
    return this.connectionPromise;
  }
  /**
   * Sends a message to the backend.
   * @param routingKey The key to route the message by.
   * @param payload The data to send.
   */
  async emit(routingKey, payload) {
    await this._ensureConnected();
    this.ws?.send(JSON.stringify({ action: "emit", routingKey, payload }));
  }
  /**
   * Listens for messages matching a binding pattern.
   * @param bindingKey The pattern to listen for (e.g., 'chat.message', 'user.*').
   * @param callback The function to call with the message payload.
   */
  async listen(bindingKey, callback) {
    await this._ensureConnected();
    const existing = this.listeners.get(bindingKey);
    if (existing) {
      existing.push(callback);
    } else {
      this.listeners.set(bindingKey, [callback]);
      this.ws?.send(JSON.stringify({ action: "listen", bindingKey }));
    }
  }
  /**
   * Stops listening for messages.
   * @param bindingKey The pattern to stop listening for.
   * @param callback The specific callback to remove.
   */
  async unlisten(bindingKey, callback) {
    const callbacks = this.listeners.get(bindingKey);
    if (!callbacks) return;
    const filteredCallbacks = callbacks.filter((cb) => cb !== callback);
    if (filteredCallbacks.length > 0) {
      this.listeners.set(bindingKey, filteredCallbacks);
    } else {
      this.listeners.delete(bindingKey);
      await this._ensureConnected();
      this.ws?.send(JSON.stringify({ action: "unlisten", bindingKey }));
    }
  }
};
var defaultClient = new WebMQClient();
var setup = defaultClient.setup.bind(defaultClient);
var connect = defaultClient.connect.bind(defaultClient);
var emit = defaultClient.emit.bind(defaultClient);
var listen = defaultClient.listen.bind(defaultClient);
var unlisten = defaultClient.unlisten.bind(defaultClient);
export {
  WebMQClient,
  connect,
  emit,
  listen,
  setup,
  unlisten
};
