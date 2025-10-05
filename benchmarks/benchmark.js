import { spawn } from 'child_process';
import { Command } from 'commander';
import getPort from 'get-port';
import { GenericContainer } from 'testcontainers';
import { BenchmarkClient } from './client.js';

const program = new Command();

program
  .option('--clients <number>', 'Number of WebSocket clients', '100')
  .option('--backends <number>', 'Number of backend processes', '1')
  .option('--listens <number>', 'Number of subscriptions per client', '10')
  .option('--publish-rate <number>', 'Messages per second per client', '5')
  .option('--key-pool-size <number>', 'Size of routing key pool', '50')
  .option('--duration <number>', 'Test duration in seconds', '10')
  .option('--message-size <number>', 'Message payload size in bytes', '1024')
  .parse();

const opts = program.opts();
const config = {
  clients: parseInt(opts.clients),
  backends: parseInt(opts.backends),
  listens: parseInt(opts.listens),
  publishRate: parseInt(opts.publishRate),
  keyPoolSize: parseInt(opts.keyPoolSize),
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

let rabbitmqContainer;
let backendProcesses = [];
let clients = [];

async function cleanup() {
  console.log('\n🧹 Cleaning up...');

  // Kill backend processes
  for (const proc of backendProcesses) {
    proc.kill();
  }

  // Stop RabbitMQ
  if (rabbitmqContainer) {
    await rabbitmqContainer.stop();
  }

  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

try {
  // Start RabbitMQ
  console.log('🐰 Starting RabbitMQ...');
  rabbitmqContainer = await new GenericContainer('rabbitmq:3.11-management')
    .withExposedPorts(5672)
    .start();

  const rabbitmqPort = rabbitmqContainer.getMappedPort(5672);
  const rabbitmqUrl = `amqp://localhost:${rabbitmqPort}`;
  console.log(`✅ RabbitMQ started on port ${rabbitmqPort}`);

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

  // Create clients
  console.log(`\n👥 Creating ${config.clients} client(s)...`);
  const listenersPerKey = new Map(); // Track which clients listen to which keys

  for (let i = 0; i < config.clients; i++) {
    const port = backendPorts[i % config.backends];
    const client = new BenchmarkClient(`ws://localhost:${port}`, config.keyPoolSize, config.listens);
    await client.connect();
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
  console.log(`✅ Clients connected`);

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

  // Wait a bit for in-flight messages
  await new Promise(resolve => setTimeout(resolve, 1000));

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
