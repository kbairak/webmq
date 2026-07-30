# Observability

WebMQ exposes built-in health checks and Prometheus metrics for monitoring.

## Health check

When enabled, the server exposes a health check endpoint that verifies RabbitMQ connectivity and WebSocket server status.

### Configuration

```javascript
const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080,
  healthEndpoint: '/health'   // Default: /health
});
```

### Response

```json
{
  "healthy": true,
  "rabbitMQQueues": 5,
  "websockets": 42
}
```

- HTTP 200 when healthy
- HTTP 503 when unhealthy (RabbitMQ disconnected or consecutive channel failures)

### Disable

Omit `healthEndpoint` from the options (or set to empty string).

## Prometheus metrics

WebMQ exposes standard Prometheus metrics for monitoring message throughput, connections, and errors.

### Configuration

```javascript
const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080,
  metricsEndpoint: '/metrics'  // Default: /metrics
});
```

### Available metrics

| Metric | Type | Description |
|---|---|---|
| `webmq_websocket_connections` | Gauge | Current active WebSocket connections |
| `webmq_rabbitmq_consumers` | Gauge | Current RabbitMQ consumers |
| `webmq_websocket_messages_received_total` | Counter | Messages received from WebSocket clients |
| `webmq_websocket_to_rabbitmq_publishes_total` | Counter | Messages published to RabbitMQ |
| `webmq_rabbitmq_to_websocket_publishes_total` | Counter | Messages forwarded from RMQ to WebSocket |
| `webmq_rabbitmq_bindings` | Gauge | Current RabbitMQ bindings |
| `webmq_rabbitmq_messages_acked_total` | Counter | Messages acknowledged to RabbitMQ |
| `webmq_rabbitmq_messages_nacked_total` | Counter | Messages negatively acknowledged (requeued) |
| `webmq_rabbitmq_consecutive_channel_failures` | Gauge | Consecutive RabbitMQ channel failures |
| `webmq_errors_total` | Counter | Errors by type |
| `process_*` | — | Default Prometheus process metrics (enabled automatically) |

### Prometheus scrape config

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'webmq'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:8080']
```

### Grafana queries

```promql
# Messages per second
rate(webmq_websocket_to_rabbitmq_publishes_total[1m])

# Active connections over time
webmq_websocket_connections

# Error rate by type
rate(webmq_errors_total[5m])

# RabbitMQ health
webmq_rabbitmq_consecutive_channel_failures
```

## Logging

Both frontend and backend support configurable log levels:

```javascript
// Frontend
import WebMQClient from 'webmq-frontend';
const client = new WebMQClient({ url: 'ws://localhost:8080', sessionId: 'abc' });
client.logLevel = 'DEBUG';  // 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT'

// Backend
const server = new WebMQServer({
  rmqUrl: 'amqp://localhost',
  exchange: 'my_app',
  port: 8080,
  logLevel: 'INFO'  // Same levels as frontend
});
// Or set after construction:
server.logLevel = 'DEBUG';
```

Level hierarchy: `SILENT` < `ERROR` < `WARNING` < `INFO` < `DEBUG`.

## Benchmarking

The project includes a benchmarking suite at `benchmarks/` for measuring throughput and latency under load. See the [benchmarks README](https://github.com/kbairak/webmq/tree/main/benchmarks) for details.
