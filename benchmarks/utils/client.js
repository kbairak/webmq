/**
 * WebMQ client simulator for benchmarks
 */
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class WebMQClient extends EventEmitter {
  constructor(url = 'ws://localhost:8080') {
    super();
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.listeners = new Map(); // topic -> Set of callbacks
    this.pendingMessages = new Map(); // messageId -> { timestamp, resolve, reject }
    this.messageId = 0;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.connected = true;
        super.emit('connected');
        resolve();
      });

      this.ws.on('close', () => {
        this.connected = false;
        super.emit('disconnected');
      });

      this.ws.on('error', (error) => {
        super.emit('error', error);
        reject(error);
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          super.emit('error', error);
        }
      });

      // Connection timeout
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 5000);
    });
  }

  handleMessage(message) {
    if (message.type === 'message') {
      // Incoming message from subscription
      const { bindingKey, payload } = message;
      const callbacks = this.listeners.get(bindingKey);
      if (callbacks) {
        callbacks.forEach(callback => {
          try {
            callback(payload);
          } catch (error) {
            super.emit('error', error);
          }
        });
      }
      super.emit('message', { topic: bindingKey, payload });
    } else if (message.type === 'error') {
      super.emit('error', new Error(message.message));
    }
  }

  async listen(topic, callback) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    // Add callback to listeners
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    this.listeners.get(topic).add(callback);

    // Send listen message to server
    const message = {
      action: 'listen',
      bindingKey: topic
    };

    this.ws.send(JSON.stringify(message));
  }

  async unlisten(topic, callback = null) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const callbacks = this.listeners.get(topic);
    if (callbacks) {
      if (callback) {
        callbacks.delete(callback);
        // Only unlisten from server if no more callbacks
        if (callbacks.size === 0) {
          this.listeners.delete(topic);
          this.sendUnlisten(topic);
        }
      } else {
        // Remove all callbacks
        this.listeners.delete(topic);
        this.sendUnlisten(topic);
      }
    }
  }

  sendUnlisten(topic) {
    const message = {
      action: 'unlisten',
      bindingKey: topic
    };
    this.ws.send(JSON.stringify(message));
  }

  async emit(topic, payload) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const message = {
      action: 'emit',
      routingKey: topic,
      payload
    };

    this.ws.send(JSON.stringify(message));
  }

  // Emit with latency tracking
  async emitWithTracking(topic, payload) {
    const messageId = this.messageId++;
    const timestamp = Date.now();

    // Add timestamp to payload for latency measurement
    const trackingPayload = {
      ...payload,
      _messageId: messageId,
      _timestamp: timestamp
    };

    await this.emit(topic, trackingPayload);
    return { messageId, timestamp };
  }

  disconnect() {
    if (this.ws) {
      this.connected = false;
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected() {
    return this.connected;
  }

  getListenerCount() {
    let total = 0;
    this.listeners.forEach(callbacks => {
      total += callbacks.size;
    });
    return total;
  }

  getTopics() {
    return Array.from(this.listeners.keys());
  }
}

module.exports = { WebMQClient };