/**
 * Metrics collector for Prometheus integration.
 * Tracks in-memory metrics and exports in Prometheus text format.
 */
export class MetricsCollector {
  // Counters (monotonically increasing)
  private messagesPublished = 0;
  private messagesReceived = 0;
  private errorsByType = new Map<string, number>();

  // Gauges (current value)
  private activeConnections = 0;
  private rabbitmqConnected = 0; // 0 or 1
  private activeSubscriptions = 0;

  // Histograms for latency (buckets in seconds)
  private readonly publishLatencyBuckets = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
  private publishLatencyHistogram = new Map<number, number>(
    [[0.001, 0], [0.005, 0], [0.01, 0], [0.05, 0], [0.1, 0], [0.5, 0]]
  );
  private publishLatencySum = 0;
  private publishLatencyCount = 0;

  private readonly hookLatencyBuckets = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
  private hookLatencyHistogram = new Map<string, Map<number, number>>();
  private hookLatencySum = new Map<string, number>();
  private hookLatencyCount = new Map<string, number>();

  // Per-routing-key counters (optional, can be high cardinality)
  private messagesByRoutingKey = new Map<string, number>();
  private subscriptionsByBindingKey = new Map<string, number>();

  // Counters
  incrementPublished(routingKey: string): void {
    this.messagesPublished++;
    this.messagesByRoutingKey.set(
      routingKey,
      (this.messagesByRoutingKey.get(routingKey) || 0) + 1
    );
  }

  incrementReceived(): void {
    this.messagesReceived++;
  }

  incrementErrors(type: string): void {
    this.errorsByType.set(type, (this.errorsByType.get(type) || 0) + 1);
  }

  // Gauges
  incrementConnections(): void {
    this.activeConnections++;
  }

  decrementConnections(): void {
    this.activeConnections--;
  }

  setRabbitmqConnected(connected: boolean): void {
    this.rabbitmqConnected = connected ? 1 : 0;
  }

  incrementSubscriptions(bindingKey: string): void {
    this.activeSubscriptions++;
    this.subscriptionsByBindingKey.set(
      bindingKey,
      (this.subscriptionsByBindingKey.get(bindingKey) || 0) + 1
    );
  }

  decrementSubscriptions(bindingKey: string): void {
    this.activeSubscriptions--;
    const current = this.subscriptionsByBindingKey.get(bindingKey) || 0;
    if (current > 0) {
      this.subscriptionsByBindingKey.set(bindingKey, current - 1);
    }
  }

  // Histograms
  recordPublishLatency(seconds: number): void {
    this.publishLatencyCount++;
    this.publishLatencySum += seconds;

    for (const bucket of this.publishLatencyBuckets) {
      if (seconds <= bucket) {
        this.publishLatencyHistogram.set(
          bucket,
          (this.publishLatencyHistogram.get(bucket) || 0) + 1
        );
      }
    }
  }

  recordHookLatency(hookType: string, seconds: number): void {
    // Initialize if needed
    if (!this.hookLatencyHistogram.has(hookType)) {
      const buckets = new Map<number, number>();
      for (const bucket of this.hookLatencyBuckets) {
        buckets.set(bucket, 0);
      }
      this.hookLatencyHistogram.set(hookType, buckets);
      this.hookLatencySum.set(hookType, 0);
      this.hookLatencyCount.set(hookType, 0);
    }

    const count = (this.hookLatencyCount.get(hookType) || 0) + 1;
    const sum = (this.hookLatencySum.get(hookType) || 0) + seconds;
    this.hookLatencyCount.set(hookType, count);
    this.hookLatencySum.set(hookType, sum);

    const buckets = this.hookLatencyHistogram.get(hookType)!;
    for (const bucket of this.hookLatencyBuckets) {
      if (seconds <= bucket) {
        buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
      }
    }
  }

  /**
   * Export metrics in Prometheus text format.
   * See: https://prometheus.io/docs/instrumenting/exposition_formats/
   */
  toPrometheusFormat(): string {
    let output = '';

    // Counter: Messages published
    output += '# HELP webmq_messages_published_total Total messages published to RabbitMQ\n';
    output += '# TYPE webmq_messages_published_total counter\n';
    output += `webmq_messages_published_total ${this.messagesPublished}\n\n`;

    // Counter: Messages received
    output += '# HELP webmq_messages_received_total Total messages received from RabbitMQ\n';
    output += '# TYPE webmq_messages_received_total counter\n';
    output += `webmq_messages_received_total ${this.messagesReceived}\n\n`;

    // Counter: Errors by type
    output += '# HELP webmq_errors_total Total errors by type\n';
    output += '# TYPE webmq_errors_total counter\n';
    for (const [type, count] of this.errorsByType) {
      output += `webmq_errors_total{type="${type}"} ${count}\n`;
    }
    output += '\n';

    // Gauge: Active connections
    output += '# HELP webmq_connections_active Current active WebSocket connections\n';
    output += '# TYPE webmq_connections_active gauge\n';
    output += `webmq_connections_active ${this.activeConnections}\n\n`;

    // Gauge: RabbitMQ connection status
    output += '# HELP webmq_rabbitmq_connected RabbitMQ connection status (0=disconnected, 1=connected)\n';
    output += '# TYPE webmq_rabbitmq_connected gauge\n';
    output += `webmq_rabbitmq_connected ${this.rabbitmqConnected}\n\n`;

    // Gauge: Active subscriptions
    output += '# HELP webmq_subscriptions_active Current active subscriptions\n';
    output += '# TYPE webmq_subscriptions_active gauge\n';
    output += `webmq_subscriptions_active ${this.activeSubscriptions}\n\n`;

    // Histogram: Publish latency
    output += '# HELP webmq_publish_duration_seconds Time to publish message to RabbitMQ\n';
    output += '# TYPE webmq_publish_duration_seconds histogram\n';
    for (const [bucket, count] of this.publishLatencyHistogram) {
      output += `webmq_publish_duration_seconds_bucket{le="${bucket}"} ${count}\n`;
    }
    output += `webmq_publish_duration_seconds_bucket{le="+Inf"} ${this.publishLatencyCount}\n`;
    output += `webmq_publish_duration_seconds_sum ${this.publishLatencySum}\n`;
    output += `webmq_publish_duration_seconds_count ${this.publishLatencyCount}\n\n`;

    // Histogram: Hook latency by type
    if (this.hookLatencyHistogram.size > 0) {
      output += '# HELP webmq_hook_duration_seconds Hook execution duration by type\n';
      output += '# TYPE webmq_hook_duration_seconds histogram\n';
      for (const [hookType, buckets] of this.hookLatencyHistogram) {
        for (const [bucket, count] of buckets) {
          output += `webmq_hook_duration_seconds_bucket{hook="${hookType}",le="${bucket}"} ${count}\n`;
        }
        output += `webmq_hook_duration_seconds_bucket{hook="${hookType}",le="+Inf"} ${this.hookLatencyCount.get(hookType) || 0}\n`;
        output += `webmq_hook_duration_seconds_sum{hook="${hookType}"} ${this.hookLatencySum.get(hookType) || 0}\n`;
        output += `webmq_hook_duration_seconds_count{hook="${hookType}"} ${this.hookLatencyCount.get(hookType) || 0}\n`;
      }
      output += '\n';
    }

    // Counter: Messages by routing key
    if (this.messagesByRoutingKey.size > 0) {
      output += '# HELP webmq_messages_by_routing_key Messages published by routing key\n';
      output += '# TYPE webmq_messages_by_routing_key counter\n';
      for (const [key, count] of this.messagesByRoutingKey) {
        output += `webmq_messages_by_routing_key{routing_key="${key}"} ${count}\n`;
      }
      output += '\n';
    }

    // Gauge: Subscriptions by binding key
    if (this.subscriptionsByBindingKey.size > 0) {
      output += '# HELP webmq_subscriptions_by_binding_key Active subscriptions by binding key\n';
      output += '# TYPE webmq_subscriptions_by_binding_key gauge\n';
      for (const [key, count] of this.subscriptionsByBindingKey) {
        output += `webmq_subscriptions_by_binding_key{binding_key="${key}"} ${count}\n`;
      }
      output += '\n';
    }

    return output;
  }
}
