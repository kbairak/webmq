import { WebMQClient } from 'webmq-frontend';

export class BenchmarkClient {
  constructor(wsUrl, keyPoolSize, numListens) {
    this.wsUrl = wsUrl;
    this.keyPoolSize = keyPoolSize;
    this.numListens = numListens;
    this.receivedMessages = [];
    this.publishedCount = 0;
    this.listenKeys = new Set();
    this.client = new WebMQClient();
    this.client.logLevel = 'silent'; // Reduce noise
  }

  async connect() {
    return new Promise((resolve) => {
      this.client.setup(this.wsUrl);

      // Pick random keys to listen to
      while (this.listenKeys.size < this.numListens) {
        const key = Math.floor(Math.random() * this.keyPoolSize);
        this.listenKeys.add(key);
      }

      // Listen to selected keys
      for (const key of this.listenKeys) {
        this.client.listen(String(key), (msg) => {
          this.receivedMessages.push({
            ...msg,
            receivedAt: Date.now()
          });
        });
      }

      // Give a moment for setup to complete
      setTimeout(resolve, 200);
    });
  }

  publishMessage(messageSize, listenersPerKey) {
    const key = String(Math.floor(Math.random() * this.keyPoolSize));
    const padding = 'x'.repeat(Math.max(0, messageSize - 100)); // Rough size padding

    const message = {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      payload: padding
    };

    this.client.publish(key, message);
    this.publishedCount++;

    // Return expected deliveries for this publish
    return listenersPerKey.get(key)?.size || 0;
  }

  getStats() {
    return {
      published: this.publishedCount,
      received: this.receivedMessages.length,
      latencies: this.receivedMessages.map(msg => msg.receivedAt - msg.timestamp)
    };
  }

  disconnect() {
    // Close connection
    if (this.client) {
      this.client.close();
    }
  }
}
