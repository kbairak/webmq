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
| `--key-pool-size <n>` | Routing key pool size (0..n-1) | 50 |
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
node benchmark.js --clients 100 --key-pool-size 1000
```

**High contention (small key pool):**
```bash
node benchmark.js --clients 100 --key-pool-size 10
```

## How It Works

1. **Starts RabbitMQ** via testcontainers
2. **Spawns N backend processes** on auto-discovered ports
3. **Creates M clients** distributed round-robin across backends
4. **Each client**:
   - Picks random keys from pool to listen to
   - Publishes messages at specified rate to random keys
   - Tracks received messages with latency
5. **Aggregates results** and displays metrics

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

### Finding the Breaking Point (Per-Client Channels)

| Config | Backends | Latency (p50/p99) | Throughput | Loss | Notes |
|--------|----------|-------------------|------------|------|-------|
| 100 clients, 5 msg/s | 1 | 18ms / 120ms | 9,950 msg/s | 0% | ✅ Healthy |
| 200 clients, 5 msg/s | 1 | 956ms / 3,839ms | 39,726 msg/s | **0%** | ⚠️ High latency but no loss |
| 200 clients, 5 msg/s | 4 | 39ms / 850ms | 38,618 msg/s | 0% | ✅ Better |
| 300 clients, 5 msg/s | 1 | 5,261ms / 28,609ms | 6,134 msg/s | 93% | ❌ Severe overload |
| 300 clients, 5 msg/s | 4 | 14,635ms / 27,644ms | 10,483 msg/s | 88% | ❌ Still overloaded |

**Key Findings:**
1. **Single backend handles 200 clients without message loss** - high latency (956ms p50) but reliable
2. **100 clients per backend is the sweet spot** - low latency (18ms p50), 0% loss
3. **Beyond 300 clients, even 4 backends struggle** - extreme fan-out (60x) creates bottleneck
4. **Scaling backends helps with latency** - 200 clients: 4 backends reduce p50 from 956ms to 39ms

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
