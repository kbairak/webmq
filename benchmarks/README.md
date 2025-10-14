# WebMQ Benchmarks

Performance benchmarking tool for WebMQ framework with real-time Prometheus metrics and Grafana dashboards.

## Features

- **Real-time Monitoring**: Prometheus metrics + Grafana dashboards with 1s refresh
- **Automated Setup**: RabbitMQ, Prometheus, and Grafana via Docker Compose
- **Horizontal Scaling**: Test multiple backend processes with round-robin client distribution
- **Performance Metrics**: Latency percentiles (p50/p95/p99), throughput, message loss, drain time
- **Configurable Load**: Control clients, backends, subscriptions, publish rate, key pool size

## Quick Start

```bash
cd benchmarks
npm install

# Make script executable (if needed)
chmod +x run-benchmark.sh

# Run with Grafana dashboard (recommended)
./run-benchmark.sh --clients 10 --duration 30

# Or run standalone
node benchmark.js --clients 10 --duration 5
```

The `run-benchmark.sh` script:
1. Starts Docker services (RabbitMQ, Prometheus, Grafana)
2. Opens Grafana dashboard at http://localhost:3000
3. Runs the benchmark
4. Cleans up Docker services on exit

## Usage

**With monitoring (recommended):**
```bash
./run-benchmark.sh [options]
```

**Standalone (no monitoring):**
```bash
node benchmark.js [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--clients <n>` | Number of WebSocket clients | 100 |
| `--backends <n>` | Number of backend processes | 1 |
| `--listens <n>` | Subscriptions per client | 10 |
| `--publish-rate <n>` | Messages/sec per client | 5 |
| `--key-pool-size <n>` | Routing key pool size (0..n-1) | clients/2 |
| `--duration <n>` | Test duration (seconds) | 10 |
| `--message-size <n>` | Payload size (bytes) | 1024 |

### Examples

**Quick test with monitoring:**
```bash
./run-benchmark.sh --clients 10 --duration 30
```

**High load test:**
```bash
./run-benchmark.sh --clients 500 --backends 4 --publish-rate 10 --duration 60
```

**Low contention (large key pool):**
```bash
./run-benchmark.sh --clients 100 --key-pool-size 500 --duration 30
```

**High contention (small key pool):**
```bash
./run-benchmark.sh --clients 100 --key-pool-size 5 --duration 30
```

**Standalone (no Grafana):**
```bash
node benchmark.js --clients 10 --duration 5
```

## Monitoring Setup

The benchmark includes a complete observability stack:

**Services:**
- **RabbitMQ** (localhost:5672) - Message broker
- **Prometheus** (localhost:9090) - Metrics collection (1s scrape interval)
- **Grafana** (localhost:3000) - Visualization dashboard

**Metrics Exposed:**

*WebMQ Metrics:*
- `webmq_connections_active` - Active WebSocket connections
- `webmq_messages_published_total` - Total messages published
- `webmq_messages_received_total` - Total messages received
- `webmq_publish_duration_seconds` - Publish latency histogram
- `webmq_messages_by_routing_key` - Per-key message counters
- `webmq_subscriptions_active` - Active subscriptions
- `webmq_rabbitmq_connected` - RabbitMQ connection status
- `webmq_errors_total` - Error counters by type

*RabbitMQ Metrics:*
- `rabbitmq_queue_messages_ready` - Messages ready for delivery
- `rabbitmq_queue_messages_unacknowledged` - Messages delivered but not acked
- `rabbitmq_process_resident_memory_bytes` - RabbitMQ memory usage
- `rabbitmq_channel_messages_published_total` - Total messages published to broker
- `rabbitmq_channel_messages_delivered_total` - Total messages delivered by broker
- `rabbitmq_channel_messages_acknowledged_total` - Total messages acknowledged
- `rabbitmq_connections` - Active connections to RabbitMQ
- `rabbitmq_channels` - Active channels in RabbitMQ

**Grafana Dashboard:**
- Real-time graphs with 1s refresh rate
- Message throughput (publish/receive rates)
- Latency distribution (p50/p95/p99)
- Connection tracking
- Per-backend metrics
- RabbitMQ broker metrics (queue depth, memory usage, message rates, connections)

Access points:
- Grafana: http://localhost:3000 (auto-opens with `run-benchmark.sh`)
- Prometheus: http://localhost:9090
- RabbitMQ Management: http://localhost:15672 (guest/guest)
- RabbitMQ Metrics: http://localhost:15692/metrics

## How It Works

1. **Starts infrastructure** (when using `run-benchmark.sh`):
   - RabbitMQ, Prometheus, Grafana via Docker Compose
   - Configures Prometheus to scrape backend metrics
2. **Spawns N backend processes** on auto-discovered ports with metrics enabled
3. **Creates M clients** distributed round-robin across backends
4. **Each client**:
   - Picks random keys from pool to listen to
   - Publishes messages at specified rate to random keys
   - Tracks received messages with latency
5. **Stops publishing** after duration, then **dynamically drains queues**:
   - Checks every second if new messages are arriving
   - Stops when no new messages for 3 consecutive seconds
   - Safety timeout at 3× test duration (prevents infinite wait)
6. **Aggregates results** and displays metrics including drain time

> **Note:** Dynamic draining ensures accurate loss measurement. Healthy systems drain quickly (<10s), while overloaded systems hit the timeout still processing queued messages. Drain time is a key indicator of system stress.

## Output

```
🚀 Starting benchmark...
  Clients: 100
  Backends: 4
  Key pool size: 50
  Duration: 10s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Results
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Latency:
  p50: 12ms
  p95: 45ms
  p99: 89ms
  max: 234ms

Throughput:
  Published: 2,400 msgs (480 msg/s)
  Expected: 47,429 msgs (9,486 msg/s)
  Delivered: 47,429 msgs (9,486 msg/s)
  Fan-out ratio: 19.76x
  Loss: 0.00%

Backend Distribution:
  Backend 0 (port 8080): 312 msg/s
  Backend 1 (port 8081): 311 msg/s
  Backend 2 (port 8082): 310 msg/s
  Backend 3 (port 8083): 312 msg/s
```

### Understanding Metrics

**Published:** Total messages sent by all clients

**Expected:** Calculated deliveries based on listener overlap
- For each publish to key K, counts how many clients listen to K
- Sum of all expected deliveries

**Delivered:** Actual messages received by all clients

**Fan-out ratio:** Expected / Published
- Average number of clients receiving each message
- Higher ratio = more listener overlap (smaller key pool or more clients)

**Loss:** (Expected - Delivered) / Expected
- **0%** = Perfect! All expected messages delivered
- **Positive %** = Messages lost (bad!)
- Should always be 0% or very close in healthy system

## Interpreting Results

**Latency:**
- p50: Median latency (50% of messages faster than this)
- p95: 95th percentile (outliers excluded)
- p99: 99th percentile (rare worst-case)

**Throughput:**
- Shows message rates for published/expected/delivered
- Fan-out ratio indicates average broadcast amplification

**Backend Distribution:**
- Shows load balancing across backend processes
- Should be roughly equal for round-robin distribution

### Using WebMQ + RabbitMQ Metrics Together

The benchmark exposes metrics from both WebMQ backends and the RabbitMQ broker, providing end-to-end visibility into your message flow. Comparing these metrics helps identify bottlenecks:

**Scenario 1: Low WebMQ latency, growing RabbitMQ queue depth**
- **Symptom:** `webmq_publish_duration_seconds` is low (< 50ms) but `rabbitmq_queue_messages_ready` keeps growing
- **Diagnosis:** WebMQ backends are publishing faster than consumers can process
- **Action:** Scale consumers or optimize message processing

**Scenario 2: High WebMQ latency, stable RabbitMQ queues**
- **Symptom:** `webmq_publish_duration_seconds` is high (> 500ms) but `rabbitmq_queue_messages_ready` stays low
- **Diagnosis:** WebMQ backends are the bottleneck (CPU/memory saturation)
- **Action:** Add more backend processes or reduce client count per backend

**Scenario 3: Message count mismatches**
- **Symptom:** `webmq_messages_published_total` ≠ `rabbitmq_channel_messages_published_total`
- **Diagnosis:** Messages dropped before reaching RabbitMQ (connection issues, serialization errors)
- **Action:** Check `webmq_errors_total` and backend logs

**Scenario 4: High RabbitMQ memory usage**
- **Symptom:** `rabbitmq_process_resident_memory_bytes` growing rapidly
- **Diagnosis:** Queue buildup due to slow consumers or high message size
- **Action:** Increase message processing rate or reduce message size

**Key Correlation Points:**
- `webmq_messages_published_total` should match `rabbitmq_channel_messages_published_total` (no drops)
- `rabbitmq_channel_messages_delivered_total` should match `webmq_messages_received_total` (successful delivery)
- `rabbitmq_queue_messages_ready` staying at 0 indicates healthy throughput
- `rabbitmq_connections` should equal number of backend processes

## Benchmark Results

**Test System:** Apple M4, 16GB RAM, macOS 15.7

### Scaling Performance (Key Pool = Clients/2)

| Config | Backends | Latency (p50/p99) | Throughput | Loss | Drain Time | Notes |
|--------|----------|-------------------|------------|------|------------|-------|
| 100 clients, 5 msg/s | 1 | 12ms / 83ms | 9,852 msg/s | 0% | 4.2s | ✅ Excellent |
| 200 clients, 5 msg/s | 1 | 50ms / 156ms | 19,607 msg/s | 0% | 4.3s | ✅ Healthy |
| 200 clients, 5 msg/s | 4 | 11ms / 129ms | 19,630 msg/s | 0% | 4.4s | ✅ Lower latency |
| 300 clients, 5 msg/s | 1 | 99ms / 693ms | 29,539 msg/s | 0% | 4.4s | ✅ Still good! |
| 300 clients, 5 msg/s | 4 | 2,306ms / 6,052ms | 29,007 msg/s | 0% | 7.7s | ⚠️ High latency |
| 400 clients, 5 msg/s | 4 | 120ms / 819ms | 38,256 msg/s | 0% | 4.7s | ✅ Surprisingly good |

**Key Findings:**
1. **Scaling key pool with clients dramatically improves performance** - keeps fan-out ratio constant at ~20x regardless of client count
2. **0% message loss across all tested scenarios** - system handles up to 400 clients reliably
3. **300 clients with 4 backends shows latency spike** - p99 jumps to 6s despite 0% loss, suggesting temporary queuing
4. **400 clients performs better than 300** - lower latency (120ms vs 2.3s p50), likely due to better load distribution with 100 clients/backend

## Architecture Insights

**When to scale backends:**
- **Latency degradation** - p99 > 100ms indicates backend saturation
- **Message loss** - Any non-zero loss percentage
- **High client count** - 100+ concurrent connections per backend
- **CPU-bound** - High serialization/deserialization load

**When backends won't help:**
- **RabbitMQ bottleneck** - Queue depth growing, consumer lag
- **Extreme fan-out** - 60x+ ratio creates too much total throughput
- **Network saturation** - Bandwidth limits reached

**Key pool size effects:**
- **Small pool** (< clients/5): High contention, extreme fan-out (40x+)
- **Large pool** (> clients): Low contention, point-to-point messaging (1-2x fan-out)

## Troubleshooting

**Port already in use:**
```bash
# Stop existing Docker services
docker-compose down

# Or stop specific containers
docker stop $(docker ps -q --filter ancestor=rabbitmq)
docker stop $(docker ps -q --filter ancestor=prom/prometheus)
docker stop $(docker ps -q --filter ancestor=grafana/grafana)
```

**Grafana dashboard not loading:**
- Wait 10-15 seconds after startup for Grafana to initialize
- Check service status: `docker-compose ps`
- View logs: `docker-compose logs grafana`

**Metrics not appearing in Grafana:**
- Verify Prometheus is scraping: http://localhost:9090/targets
- Check backend logs for metrics endpoint errors
- Ensure `prometheus.yml` has correct backend ports

**Clean reset:**
```bash
# Remove all containers and volumes
docker-compose down -v
rm prometheus.yml

# Restart from scratch
./run-benchmark.sh
```
