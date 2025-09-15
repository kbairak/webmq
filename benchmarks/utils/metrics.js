/**
 * Metrics collection utility for WebMQ benchmarks
 */
class Metrics {
  constructor() {
    this.latencies = [];
    this.throughput = {
      messagesReceived: 0,
      messagesSent: 0,
      startTime: Date.now(),
      intervals: []
    };
    this.errors = {
      connectionFailures: 0,
      messageFailures: 0,
      timeouts: 0
    };
    this.connections = {
      active: 0,
      peak: 0,
      established: 0,
      failed: 0
    };
  }

  // Record message latency (time from send to receive)
  recordLatency(latencyMs) {
    this.latencies.push(latencyMs);
  }

  // Record message sent
  recordMessageSent() {
    this.throughput.messagesSent++;
  }

  // Record message received
  recordMessageReceived() {
    this.throughput.messagesReceived++;
  }

  // Record connection established
  recordConnection() {
    this.connections.active++;
    this.connections.established++;
    this.connections.peak = Math.max(this.connections.peak, this.connections.active);
  }

  // Record connection closed
  recordDisconnection() {
    this.connections.active = Math.max(0, this.connections.active - 1);
  }

  // Record error
  recordError(type) {
    if (this.errors[type] !== undefined) {
      this.errors[type]++;
    }
  }

  // Take a throughput snapshot
  takeSnapshot() {
    const now = Date.now();
    const elapsed = (now - this.throughput.startTime) / 1000;
    const snapshot = {
      timestamp: now,
      elapsed,
      messagesPerSecond: this.throughput.messagesReceived / elapsed,
      sentPerSecond: this.throughput.messagesSent / elapsed,
      activeConnections: this.connections.active
    };
    this.throughput.intervals.push(snapshot);
    return snapshot;
  }

  // Calculate percentiles
  calculatePercentiles(values, percentiles = [50, 90, 95, 99]) {
    if (values.length === 0) return {};

    const sorted = [...values].sort((a, b) => a - b);
    const result = {};

    percentiles.forEach(p => {
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      result[`p${p}`] = sorted[Math.max(0, index)];
    });

    result.min = sorted[0];
    result.max = sorted[sorted.length - 1];
    result.avg = values.reduce((sum, val) => sum + val, 0) / values.length;

    return result;
  }

  // Get current resource usage
  getResourceUsage() {
    const usage = process.memoryUsage();
    const cpu = process.cpuUsage();

    return {
      memory: {
        rss: Math.round(usage.rss / 1024 / 1024), // MB
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
        external: Math.round(usage.external / 1024 / 1024) // MB
      },
      cpu: {
        user: cpu.user,
        system: cpu.system
      }
    };
  }

  // Generate comprehensive report
  generateReport() {
    const now = Date.now();
    const totalTime = (now - this.throughput.startTime) / 1000;
    const latencyStats = this.calculatePercentiles(this.latencies);
    const resources = this.getResourceUsage();

    return {
      duration: totalTime,
      throughput: {
        messagesPerSecond: this.throughput.messagesReceived / totalTime,
        totalReceived: this.throughput.messagesReceived,
        totalSent: this.throughput.messagesSent,
        intervals: this.throughput.intervals
      },
      latency: {
        count: this.latencies.length,
        ...latencyStats
      },
      connections: {
        ...this.connections
      },
      errors: {
        ...this.errors,
        total: Object.values(this.errors).reduce((sum, count) => sum + count, 0)
      },
      resources
    };
  }

  // Reset all metrics
  reset() {
    this.latencies = [];
    this.throughput = {
      messagesReceived: 0,
      messagesSent: 0,
      startTime: Date.now(),
      intervals: []
    };
    this.errors = {
      connectionFailures: 0,
      messageFailures: 0,
      timeouts: 0
    };
    this.connections = {
      active: 0,
      peak: 0,
      established: 0,
      failed: 0
    };
  }

  // Print a quick summary
  printSummary() {
    const report = this.generateReport();
    console.log('\n📊 Benchmark Summary:');
    console.log(`Duration: ${report.duration.toFixed(2)}s`);
    console.log(`Messages/sec: ${report.throughput.messagesPerSecond.toFixed(2)}`);
    console.log(`Total messages: ${report.throughput.totalReceived}`);
    console.log(`Connections: ${report.connections.established} established, ${report.connections.peak} peak`);

    if (report.latency.count > 0) {
      console.log(`Latency: p50=${report.latency.p50}ms p95=${report.latency.p95}ms p99=${report.latency.p99}ms`);
    }

    if (report.errors.total > 0) {
      console.log(`Errors: ${report.errors.total} total`);
    }

    console.log(`Memory: ${report.resources.memory.heapUsed}MB heap, ${report.resources.memory.rss}MB RSS`);
  }
}

module.exports = { Metrics };