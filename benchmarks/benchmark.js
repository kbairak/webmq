import { spawn } from 'child_process';
import { Command } from 'commander';
import getPort from 'get-port';
import { writeFileSync } from 'fs';
import { WebSocket } from 'ws';
import { BenchmarkClient } from './client.js';

// Polyfill WebSocket for Node.js
global.WebSocket = WebSocket;

const program = new Command();

program
  .option('--clients <number>', 'Number of WebSocket clients', '100')
  .option('--backends <number>', 'Number of backend processes', '1')
  .option('--listens <number>', 'Number of subscriptions per client', '10')
  .option('--publish-rate <number>', 'Messages per second per client', '5')
  .option('--key-pool-size <number>', 'Size of routing key pool (default: clients/2)')
  .option('--duration <number>', 'Test duration in seconds', '10')
  .option('--message-size <number>', 'Message payload size in bytes', '1024')
  .parse();

const opts = program.opts();
const numClients = parseInt(opts.clients);
const config = {
  clients: numClients,
  backends: parseInt(opts.backends),
  listens: parseInt(opts.listens),
  publishRate: parseInt(opts.publishRate),
  keyPoolSize: opts.keyPoolSize ? parseInt(opts.keyPoolSize) : Math.max(5, Math.floor(numClients / 2)),
  duration: parseInt(opts.duration),
  messageSize: parseInt(opts.messageSize)
};

console.log('🚀 Starting benchmark...');
console.log(`  Clients: ${config.clients}`);
console.log(`  Backends: ${config.backends}`);
console.log(`  Listens per client: ${config.listens}`);
console.log(`  Publish rate: ${config.publishRate} msg/s per client`);
console.log(`  Key pool size: ${config.keyPoolSize}`);
console.log(`  Duration: ${config.duration}s`);
console.log(`  Message size: ${config.messageSize} bytes`);
console.log();

let backendProcesses = [];
let clients = [];

async function cleanup() {
  console.log('\n🧹 Cleaning up...');

  // Kill backend processes
  for (const proc of backendProcesses) {
    proc.kill();
  }

  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

try {
  // RabbitMQ is started by docker-compose, use fixed port
  const rabbitmqUrl = 'amqp://localhost:5672';
  console.log('🐰 Using RabbitMQ at amqp://localhost:5672 (from docker-compose)');

  // Find available ports for backends
  const backendPorts = [];
  for (let i = 0; i < config.backends; i++) {
    const port = await getPort();
    backendPorts.push(port);
  }

  // Start backend processes
  console.log(`\n🔧 Starting ${config.backends} backend(s)...`);
  for (const port of backendPorts) {
    const proc = spawn('node', ['backend.js', port, rabbitmqUrl], {
      cwd: process.cwd(),
      stdio: 'inherit'
    });
    backendProcesses.push(proc);
  }

  // Wait for backends to start
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log(`✅ Backends started on ports ${backendPorts.join(', ')}`);

  // Update Prometheus config with backend targets
  const prometheusConfig = `global:
  scrape_interval: 1s
  evaluation_interval: 1s

scrape_configs:
  - job_name: 'webmq-backends'
    static_configs:
      - targets: [${backendPorts.map(p => `'host.docker.internal:${p}'`).join(', ')}]

  - job_name: 'rabbitmq'
    static_configs:
      - targets: ['rabbitmq:15692']
`;
  writeFileSync('prometheus.yml', prometheusConfig);
  console.log(`📊 Updated Prometheus config with ${backendPorts.length} backend target(s) + RabbitMQ`);

  // Reload Prometheus config
  try {
    await fetch('http://localhost:9090/-/reload', { method: 'POST' });
    console.log('✅ Prometheus config reloaded');
  } catch (e) {
    console.log('⚠️  Could not reload Prometheus (will use config on next restart)');
  }

  // Create clients
  console.log(`\n👥 Creating ${config.clients} client(s)...`);
  const listenersPerKey = new Map(); // Track which clients listen to which keys

  for (let i = 0; i < config.clients; i++) {
    const port = backendPorts[i % config.backends];
    const client = new BenchmarkClient(`ws://localhost:${port}`, config.keyPoolSize, config.listens);
    console.log(`  Connecting client ${i + 1}/${config.clients} to port ${port}...`);
    try {
      // Add timeout wrapper
      await Promise.race([
        client.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout after 15s')), 15000)
        )
      ]);
      console.log(`  ✓ Client ${i + 1} connected`);
    } catch (error) {
      console.error(`  ✗ Client ${i + 1} failed:`, error.message);
      console.error('  Stack:', error.stack);
      throw error;
    }
    clients.push(client);

    // Build listenersPerKey map
    for (const key of client.listenKeys) {
      const keyStr = String(key);
      if (!listenersPerKey.has(keyStr)) {
        listenersPerKey.set(keyStr, new Set());
      }
      listenersPerKey.get(keyStr).add(i);
    }
  }
  console.log(`✅ All ${config.clients} clients connected`);

  // Start publishing
  console.log(`\n📤 Publishing messages for ${config.duration}s...`);
  const publishInterval = 1000 / config.publishRate; // ms between publishes
  let totalExpectedDeliveries = 0;

  const publishTimers = clients.map(client => {
    return setInterval(() => {
      const expectedDeliveries = client.publishMessage(config.messageSize, listenersPerKey);
      totalExpectedDeliveries += expectedDeliveries;
    }, publishInterval);
  });

  // Wait for duration
  await new Promise(resolve => setTimeout(resolve, config.duration * 1000));

  // Stop publishing
  publishTimers.forEach(timer => clearInterval(timer));

  // Dynamic drain: wait for messages to stop arriving
  console.log('\n⏳ Draining queues...');
  let lastReceivedCount = 0;
  let stableSeconds = 0;
  const maxDrainTime = config.duration * 3; // Safety timeout
  const startDrain = Date.now();

  while (stableSeconds < 3 && (Date.now() - startDrain) < maxDrainTime * 1000) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const currentReceived = clients.reduce((sum, c) => sum + c.getStats().received, 0);

    if (currentReceived === lastReceivedCount) {
      stableSeconds++;
    } else {
      stableSeconds = 0;
      lastReceivedCount = currentReceived;
    }
  }

  const drainTime = ((Date.now() - startDrain) / 1000).toFixed(1);

  // Collect stats
  console.log('\n📊 Calculating results...\n');

  let totalPublished = 0;
  let totalReceived = 0;
  let allLatencies = [];

  for (const client of clients) {
    const stats = client.getStats();
    totalPublished += stats.published;
    totalReceived += stats.received;
    allLatencies.push(...stats.latencies);
  }

  // Calculate percentiles
  allLatencies.sort((a, b) => a - b);
  const p50 = allLatencies[Math.floor(allLatencies.length * 0.5)] || 0;
  const p95 = allLatencies[Math.floor(allLatencies.length * 0.95)] || 0;
  const p99 = allLatencies[Math.floor(allLatencies.length * 0.99)] || 0;
  const max = allLatencies[allLatencies.length - 1] || 0;

  const throughput = totalReceived / config.duration;
  const actualLoss = totalExpectedDeliveries > 0 ?
    ((totalExpectedDeliveries - totalReceived) / totalExpectedDeliveries * 100).toFixed(2) : 0;
  const fanoutRatio = totalPublished > 0 ?
    (totalExpectedDeliveries / totalPublished).toFixed(2) : 0;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📈 Results');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
  console.log('Latency:');
  console.log(`  p50: ${p50}ms`);
  console.log(`  p95: ${p95}ms`);
  console.log(`  p99: ${p99}ms`);
  console.log(`  max: ${max}ms`);
  console.log();
  console.log('Throughput:');
  console.log(`  Published: ${totalPublished} msgs (${(totalPublished / config.duration).toFixed(0)} msg/s)`);
  console.log(`  Expected: ${totalExpectedDeliveries} msgs (${(totalExpectedDeliveries / config.duration).toFixed(0)} msg/s)`);
  console.log(`  Delivered: ${totalReceived} msgs (${throughput.toFixed(0)} msg/s)`);
  console.log(`  Fan-out ratio: ${fanoutRatio}x`);
  console.log(`  Loss: ${actualLoss}%`);
  console.log(`  Drain time: ${drainTime}s`);
  console.log();

  if (config.backends > 1) {
    console.log('Backend Distribution:');
    for (let i = 0; i < config.backends; i++) {
      const clientsForBackend = clients.filter((_, idx) => idx % config.backends === i);
      const received = clientsForBackend.reduce((sum, c) => sum + c.getStats().received, 0);
      const rate = (received / config.duration).toFixed(0);
      console.log(`  Backend ${i} (port ${backendPorts[i]}): ${rate} msg/s`);
    }
    console.log();
  }

  await cleanup();

} catch (error) {
  console.error('❌ Error:', error);
  await cleanup();
}
