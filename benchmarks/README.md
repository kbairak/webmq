# WebMQ Benchmarks

Performance benchmarking suite for the WebMQ framework.

## Quick Start

### Prerequisites

1. **Start RabbitMQ:**
   ```bash
   # From project root
   cd ..
   docker-compose up -d
   ```

2. **Start WebMQ Backend:**
   ```bash
   # Option 1: Use the basic-chat example backend
   cd ../examples/basic-chat
   npm run start:backend

   # Option 2: Start your own WebMQ backend on port 8080
   ```

3. **Install benchmark dependencies:**
   ```bash
   npm install
   ```

### Running Benchmarks

#### Chat Scenario
Simulates a chat room with multiple users sending and receiving messages.

```bash
# Quick test (5 users, 10 seconds)
npm run chat:small

# Medium load (20 users, 30 seconds)
npm run chat:medium

# Heavy load (50 users, 60 seconds)
npm run chat:large

# Stress test (100 users, 2 minutes)
npm run chat:stress

# Custom configuration
npm run chat -- --users 30 --duration 45 --interval 1500 --room "chat.benchmark"
```

#### Command Line Options

- `--users` - Number of concurrent users (default: 10)
- `--duration` - Benchmark duration in seconds (default: 30)
- `--interval` - Message interval per user in ms (default: 2000)
- `--url` - WebMQ backend URL (default: ws://localhost:8080)
- `--room` - Chat room topic (default: chat.room.benchmark)

## Understanding Results

### Key Metrics

- **Messages/sec**: Total message throughput across all users
- **Latency percentiles**: End-to-end message delivery time
  - p50: Median latency (50% of messages faster)
  - p95: 95th percentile (95% of messages faster)
  - p99: 99th percentile (99% of messages faster)
- **Connections**: WebSocket connection statistics
- **Resource Usage**: Memory and CPU consumption

### Sample Output

```
📊 CHAT BENCHMARK RESULTS
============================================================

📋 Summary:
  Duration: 30.00s
  Users: 20
  Total messages sent: 300
  Total messages received: 6000
  Messages per second: 200.00

🔗 Connections:
  Established: 20
  Peak concurrent: 20
  Final active: 20

⚡ Latency (300 samples):
  Average: 15.50ms
  p50: 12ms
  p90: 25ms
  p95: 35ms
  p99: 85ms
  Max: 150ms

💾 Resource Usage:
  Heap used: 45MB
  RSS: 78MB
  Heap total: 52MB
```

## Benchmark Scenarios

### Chat Room (scenarios/chat.js)
- **Type**: Many-to-many messaging
- **Use case**: Real-time chat applications
- **Measures**: Fan-out latency, connection scaling, message throughput
- **Pattern**: Multiple users send messages to shared topic, all users receive all messages

### Planned Scenarios

- **Dashboard** (One-to-many): Single publisher, many subscribers
- **IoT Stream** (Many-to-one): Many sensors, few aggregators
- **Request-Response**: Client creates temporary subscriptions for responses

## Performance Expectations

### Baseline Targets
- **Latency**: <20ms p95 for local network
- **Throughput**: 1000+ messages/sec system-wide
- **Connections**: 500+ concurrent WebSocket connections
- **Memory**: <100MB heap for 100 connections

### Optimization Areas
- RabbitMQ queue creation overhead
- JSON serialization/deserialization
- WebSocket frame vs AMQP efficiency
- Hook execution pipeline

## Architecture

```
benchmarks/
├── utils/
│   ├── metrics.js     # Performance metrics collection
│   └── client.js      # WebMQ client simulator
├── scenarios/
│   └── chat.js        # Chat room benchmark
├── reports/           # Generated benchmark reports
└── README.md          # This file
```

## Development

### Adding New Scenarios

1. Create scenario file in `scenarios/`
2. Use `utils/metrics.js` for consistent measurement
3. Use `utils/client.js` for WebMQ connections
4. Add npm script to `package.json`
5. Document in this README

### Example Scenario Structure

```javascript
const { WebMQClient } = require('../utils/client');
const { Metrics } = require('../utils/metrics');

class MyBenchmark {
  constructor(options = {}) {
    this.options = { /* defaults */ ...options };
    this.metrics = new Metrics();
  }

  async run() {
    // Setup clients and connections
    // Execute benchmark logic
    // Collect metrics
    // Display results
  }
}
```

## Troubleshooting

### Common Issues

1. **Connection refused**: Ensure WebMQ backend is running on correct port
2. **RabbitMQ errors**: Check `docker-compose up -d` started RabbitMQ
3. **High latency**: Check for network issues, RabbitMQ load
4. **Memory leaks**: Long-running benchmarks may reveal connection cleanup issues

### Debug Mode

Add console logging:
```javascript
// Enable client error logging
client.on('error', console.error);
client.on('message', msg => console.log('Received:', msg));
```