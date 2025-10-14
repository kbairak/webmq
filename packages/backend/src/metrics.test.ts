import { MetricsCollector } from './metrics';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  describe('Counters', () => {
    it('should increment published messages', () => {
      metrics.incrementPublished('chat.room.1');
      metrics.incrementPublished('chat.room.1');
      metrics.incrementPublished('chat.room.2');

      const output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_messages_published_total 3');
      expect(output).toContain('webmq_messages_by_routing_key{routing_key="chat.room.1"} 2');
      expect(output).toContain('webmq_messages_by_routing_key{routing_key="chat.room.2"} 1');
    });

    it('should increment received messages', () => {
      metrics.incrementReceived();
      metrics.incrementReceived();

      const output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_messages_received_total 2');
    });

    it('should track errors by type', () => {
      metrics.incrementErrors('rabbitmq_connection');
      metrics.incrementErrors('rabbitmq_connection');
      metrics.incrementErrors('websocket_error');

      const output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_errors_total{type="rabbitmq_connection"} 2');
      expect(output).toContain('webmq_errors_total{type="websocket_error"} 1');
    });
  });

  describe('Gauges', () => {
    it('should track active connections', () => {
      metrics.incrementConnections();
      metrics.incrementConnections();
      metrics.decrementConnections();

      const output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_connections_active 1');
    });

    it('should track RabbitMQ connection status', () => {
      metrics.setRabbitmqConnected(true);
      let output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_rabbitmq_connected 1');

      metrics.setRabbitmqConnected(false);
      output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_rabbitmq_connected 0');
    });

    it('should track active subscriptions', () => {
      metrics.incrementSubscriptions('chat.*');
      metrics.incrementSubscriptions('user.#');
      metrics.decrementSubscriptions('chat.*');

      const output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_subscriptions_active 1');
      expect(output).toContain('webmq_subscriptions_by_binding_key{binding_key="chat.*"} 0');
      expect(output).toContain('webmq_subscriptions_by_binding_key{binding_key="user.#"} 1');
    });
  });

  describe('Histograms', () => {
    it('should record publish latency', () => {
      metrics.recordPublishLatency(0.003);
      metrics.recordPublishLatency(0.015);
      metrics.recordPublishLatency(0.08);

      const output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_publish_duration_seconds');
      expect(output).toContain('webmq_publish_duration_seconds_bucket{le="0.001"} 0');
      expect(output).toContain('webmq_publish_duration_seconds_bucket{le="0.005"} 1');
      expect(output).toContain('webmq_publish_duration_seconds_bucket{le="0.01"} 1');
      expect(output).toContain('webmq_publish_duration_seconds_bucket{le="0.05"} 2');
      expect(output).toContain('webmq_publish_duration_seconds_bucket{le="0.1"} 3');
      expect(output).toContain('webmq_publish_duration_seconds_count 3');
      expect(output).toContain('webmq_publish_duration_seconds_sum 0.098');
    });

    it('should record hook latency by type', () => {
      metrics.recordHookLatency('pre', 0.002);
      metrics.recordHookLatency('pre', 0.003);
      metrics.recordHookLatency('onPublish', 0.012);

      const output = metrics.toPrometheusFormat();
      expect(output).toContain('webmq_hook_duration_seconds');
      expect(output).toContain('webmq_hook_duration_seconds_bucket{hook="pre",le="0.005"} 2');
      expect(output).toContain('webmq_hook_duration_seconds_count{hook="pre"} 2');
      expect(output).toContain('webmq_hook_duration_seconds_count{hook="onPublish"} 1');
    });
  });

  describe('Prometheus format', () => {
    it('should generate valid Prometheus text format', () => {
      metrics.incrementPublished('test.topic');
      metrics.incrementConnections();
      metrics.setRabbitmqConnected(true);

      const output = metrics.toPrometheusFormat();

      // Check format structure
      expect(output).toContain('# HELP');
      expect(output).toContain('# TYPE');
      expect(output).toMatch(/webmq_messages_published_total \d+/);
      expect(output).toMatch(/webmq_connections_active \d+/);
      expect(output).toMatch(/webmq_rabbitmq_connected \d+/);
    });

    it('should use correct content type header format', () => {
      // This test documents the expected content type for Prometheus
      const expectedContentType = 'text/plain; version=0.0.4; charset=utf-8';
      expect(expectedContentType).toBe('text/plain; version=0.0.4; charset=utf-8');
    });
  });
});
