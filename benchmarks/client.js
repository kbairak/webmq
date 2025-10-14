import { WebMQClient } from 'webmq-frontend';

export class BenchmarkClient {
  constructor(wsUrl, keyPoolSize, numListens) {
    this.wsUrl = wsUrl;
    this.keyPoolSize = keyPoolSize;
    this.numListens = numListens;
    this.receivedMessages = [];
    this.publishedCount = 0;
    this.listenKeys = new Set();
    this.client = new WebMQClient({
      url: wsUrl,
      ackTimeoutDelay: 30000 // 30 seconds for benchmarks
    });
    this.client.logLevel = 'silent'; // Reduce noise
  }

  async connect() {
    // Pick random keys to listen to
    // Safety: can't have more listens than keys available
    const maxListens = Math.min(this.numListens, this.keyPoolSize);
    let attempts = 0;
    while (this.listenKeys.size < maxListens) {
      const key = Math.floor(Math.random() * this.keyPoolSize);
      this.listenKeys.add(key);
      attempts++;
      if (attempts > this.keyPoolSize * 100) {
        throw new Error('Too many attempts to generate unique keys');
      }
    }

    // Listen to selected keys one at a time to avoid overwhelming the backend
    for (const key of this.listenKeys) {
      await this.client.listen(String(key), (msg) => {
        this.receivedMessages.push({
          ...msg,
          receivedAt: Date.now()
        });
      });
    }
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
