# WebMQ Benchmarks

Performance benchmarking tool for WebMQ framework.

## Features

- **Automated Setup**: RabbitMQ via testcontainers, auto-finds available ports
- **Horizontal Scaling**: Test multiple backend processes with round-robin client distribution
- **Real Metrics**: Latency percentiles (p50/p95/p99), throughput, message loss
- **Configurable Load**: Control clients, backends, subscriptions, publish rate, key pool size

## Setup

```bash
cd benchmarks
npm install
```

## Usage

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

**Quick test:**
```bash
node benchmark.js --clients 10 --duration 5
```

**High load:**
```bash
node benchmark.js --clients 500 --backends 4 --publish-rate 10 --duration 30
```

**Low contention (large key pool):**
```bash
node benchmark.js --clients 100 --key-pool-size 500
```

**High contention (small key pool):**
```bash
node benchmark.js --clients 100 --key-pool-size 5
```

## How It Works

1. **Starts RabbitMQ** via testcontainers
2. **Spawns N backend processes** on auto-discovered ports
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
