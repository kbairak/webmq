/**
 * Chat room benchmark scenario
 * Simulates multiple users in a chat room sending and receiving messages
 */
import { WebMQClient } from '../utils/client.js';
import { Metrics } from '../utils/metrics.js';

class ChatBenchmark {
  constructor(options = {}) {
    this.options = {
      url: 'ws://localhost:8080',
      userCount: 10,
      messageInterval: 2000, // ms between messages per user
      duration: 30000, // total benchmark duration in ms
      chatRoom: 'chat.room.benchmark',
      ...options,
    };

    this.metrics = new Metrics();
    this.clients = [];
    this.isRunning = false;
    this.messageIntervals = [];
    this.snapshotInterval = null;
  }

  async setup() {
    console.log(
      `🚀 Setting up chat benchmark with ${this.options.userCount} users...`
    );

    // Create client connection promises
    const connectionPromises = Array.from(
      { length: this.options.userCount },
      async (_, i) => {
        const client = new WebMQClient(this.options.url);

        client.on('connected', () => {
          this.metrics.recordConnection();
        });

        client.on('disconnected', () => {
          this.metrics.recordDisconnection();
        });

        client.on('error', (error) => {
          this.metrics.recordError('connectionFailures');
          console.error(`Client ${i} error:`, error.message);
        });

        try {
          await client.connect();

          // Record connection manually since the event might have fired before listener was set
          this.metrics.recordConnection();

          // Set up message listener with latency tracking
          await client.listen(this.options.chatRoom, (payload) => {
            this.metrics.recordMessageReceived();

            // Calculate latency if this is a tracked message
            if (payload._timestamp) {
              const latency = Date.now() - payload._timestamp;
              this.metrics.recordLatency(latency);
            }
          });

          return client;
        } catch (error) {
          this.metrics.recordError('connectionFailures');
          console.error(`❌ Failed to connect user ${i + 1}:`, error.message);
          return null;
        }
      }
    );

    // Connect all clients in parallel
    const results = await Promise.all(connectionPromises);

    // Filter out failed connections and add successful clients
    this.clients = results.filter((client) => client !== null);

    console.log(
      `📡 ${this.clients.length} users connected and listening to ${this.options.chatRoom}`
    );
  }

  generateChatMessage(userId) {
    const messages = [
      'Hello everyone!',
      'How is everyone doing?',
      'Great to be here!',
      'Anyone want to chat?',
      'This is a test message',
      'WebMQ is pretty cool!',
      'Real-time messaging rocks',
      'Hope you all are having a great day',
      'Testing the chat functionality',
      'Message broadcasting works well',
    ];

    const randomMessage = messages[Math.floor(Math.random() * messages.length)];

    return {
      user: `User${userId}`,
      message: randomMessage,
      timestamp: new Date().toISOString(),
      room: this.options.chatRoom,
    };
  }

  async startMessageSending() {
    console.log(
      `💬 Starting message sending (${this.options.messageInterval}ms interval per user)...`
    );

    this.clients.forEach((client, userId) => {
      if (!client.isConnected()) return;

      const interval = setInterval(
        async () => {
          if (!this.isRunning) return;

          try {
            const message = this.generateChatMessage(userId);
            await client.emitWithTracking(this.options.chatRoom, message);
            this.metrics.recordMessageSent();
          } catch (error) {
            this.metrics.recordError('messageFailures');
            console.error(
              `Failed to send message from user ${userId}:`,
              error.message
            );
          }
        },
        this.options.messageInterval + Math.random() * 1000
      ); // Add some jitter

      this.messageIntervals.push(interval);
    });
  }

  startMetricsCollection() {
    // Take throughput snapshots every 5 seconds
    this.snapshotInterval = setInterval(() => {
      const snapshot = this.metrics.takeSnapshot();
      console.log(
        `📈 ${snapshot.elapsed.toFixed(1)}s - ${snapshot.messagesPerSecond.toFixed(1)} msg/s - ${snapshot.activeConnections} connections`
      );
    }, 5000);
  }

  async run() {
    console.log(`\n🎯 Starting Chat Benchmark`);
    console.log(`Users: ${this.options.userCount}`);
    console.log(`Duration: ${this.options.duration / 1000}s`);
    console.log(`Message interval: ${this.options.messageInterval}ms per user`);
    console.log(`Chat room: ${this.options.chatRoom}\n`);

    try {
      // Setup phase
      await this.setup();

      if (this.clients.length === 0) {
        throw new Error('No clients connected successfully');
      }

      // Start benchmark
      this.isRunning = true;
      this.startMetricsCollection();
      await this.startMessageSending();

      console.log(
        `⏱️  Running benchmark for ${this.options.duration / 1000} seconds...\n`
      );

      // Wait for benchmark duration
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.duration)
      );

      // Stop benchmark
      this.isRunning = false;
      this.stop();

      // Generate and display results
      const report = this.metrics.generateReport();
      this.displayResults(report);

      return report;
    } catch (error) {
      console.error('❌ Benchmark failed:', error.message);
      this.stop();
      throw error;
    }
  }

  stop() {
    this.isRunning = false;

    // Clear intervals
    this.messageIntervals.forEach((interval) => clearInterval(interval));
    this.messageIntervals = [];

    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }

    // Disconnect clients
    this.clients.forEach((client) => {
      if (client.isConnected()) {
        client.disconnect();
      }
    });

    console.log('\n🛑 Benchmark stopped');
  }

  displayResults(report) {
    console.log('\n' + '='.repeat(60));
    console.log('📊 CHAT BENCHMARK RESULTS');
    console.log('='.repeat(60));

    console.log(`\n📋 Summary:`);
    console.log(`  Duration: ${report.duration.toFixed(2)}s`);
    console.log(`  Users: ${this.options.userCount}`);
    console.log(`  Total messages sent: ${report.throughput.totalSent}`);
    console.log(
      `  Total messages received: ${report.throughput.totalReceived}`
    );
    console.log(
      `  Messages per second: ${report.throughput.messagesPerSecond.toFixed(2)}`
    );

    console.log(`\n🔗 Connections:`);
    console.log(`  Established: ${report.connections.established}`);
    console.log(`  Peak concurrent: ${report.connections.peak}`);
    console.log(`  Final active: ${report.connections.active}`);

    if (report.latency.count > 0) {
      console.log(`\n⚡ Latency (${report.latency.count} samples):`);
      console.log(`  Average: ${report.latency.avg.toFixed(2)}ms`);
      console.log(`  p50: ${report.latency.p50}ms`);
      console.log(`  p90: ${report.latency.p90}ms`);
      console.log(`  p95: ${report.latency.p95}ms`);
      console.log(`  p99: ${report.latency.p99}ms`);
      console.log(`  Max: ${report.latency.max}ms`);
    }

    if (report.errors.total > 0) {
      console.log(`\n❌ Errors:`);
      console.log(`  Connection failures: ${report.errors.connectionFailures}`);
      console.log(`  Message failures: ${report.errors.messageFailures}`);
      console.log(`  Timeouts: ${report.errors.timeouts}`);
      console.log(`  Total: ${report.errors.total}`);
    }

    console.log(`\n💾 Resource Usage:`);
    console.log(`  Heap used: ${report.resources.memory.heapUsed}MB`);
    console.log(`  RSS: ${report.resources.memory.rss}MB`);
    console.log(`  Heap total: ${report.resources.memory.heapTotal}MB`);

    console.log('\n' + '='.repeat(60));
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options = {};

  // Parse command line arguments
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    const value = args[i + 1];

    if (key === 'users') options.userCount = parseInt(value);
    else if (key === 'duration') options.duration = parseInt(value) * 1000;
    else if (key === 'interval') options.messageInterval = parseInt(value);
    else if (key === 'url') options.url = value;
    else if (key === 'room') options.chatRoom = value;
  }

  const benchmark = new ChatBenchmark(options);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n⚠️  Received SIGINT, stopping benchmark...');
    benchmark.stop();
    process.exit(0);
  });

  benchmark
    .run()
    .then(() => {
      console.log('\n✅ Benchmark completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Benchmark failed:', error.message);
      process.exit(1);
    });
}

export { ChatBenchmark };
