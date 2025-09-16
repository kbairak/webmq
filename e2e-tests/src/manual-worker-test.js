// Manual worker integration test - demonstrates complete message flow
// Run with: node manual-worker-test.js

import amqplib from 'amqplib';
import { WebMQBackend } from '../packages/backend/dist/index.js';
import { WebMQClient } from '../packages/frontend/dist/index.js';

async function runWorkerIntegrationTest() {
  console.log('🚀 Starting Manual Worker Integration Test...');

  // Use existing RabbitMQ (make sure it's running via docker-compose)
  const rabbitmqUrl = 'amqp://guest:guest@localhost:5672';
  const exchangeName = 'webmq_manual_test_exchange';
  const backendPort = 8090;

  let workerConnection, workerChannel, backend, client;
  const receivedMessages = [];

  try {
    // 1. Set up RabbitMQ worker (direct AMQP consumer)
    console.log('📡 Setting up RabbitMQ worker...');
    workerConnection = await amqplib.connect(rabbitmqUrl);
    workerChannel = await workerConnection.createChannel();

    await workerChannel.assertExchange(exchangeName, 'topic', { durable: false });

    // Create worker queue
    const workerQueue = await workerChannel.assertQueue('manual_worker_queue', {
      exclusive: false,
      autoDelete: true
    });

    // Bind to routing key pattern
    await workerChannel.bindQueue(workerQueue.queue, exchangeName, 'worker.task.*');

    // Set up worker consumer
    await workerChannel.consume(workerQueue.queue, (msg) => {
      if (msg) {
        const payload = JSON.parse(msg.content.toString());
        console.log('🎯 Worker received message:', {
          routingKey: msg.fields.routingKey,
          payload: payload
        });
        receivedMessages.push({
          routingKey: msg.fields.routingKey,
          payload: payload,
          timestamp: Date.now()
        });
        workerChannel.ack(msg);
      }
    });

    console.log('✅ Worker setup complete, listening for messages...');

    // 2. Start WebMQ Backend
    console.log(`🖥️  Starting WebMQ backend on port ${backendPort}...`);
    backend = new WebMQBackend({
      rabbitmqUrl,
      exchangeName: exchangeName
    });

    await backend.start(backendPort);
    console.log('✅ WebMQ backend started');

    // 3. Create and connect WebMQ Client
    console.log('📱 Creating WebMQ client...');
    client = new WebMQClient();
    client.setup(`ws://localhost:${backendPort}`);

    // Wait for connection
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
      client.connect().catch(reject);
    });

    console.log('✅ WebMQ client connected');

    // 4. Test message flow: Frontend → Backend → RabbitMQ → Worker
    console.log('\n🧪 Testing message flow...');

    const testMessage = {
      taskId: 'manual-test-001',
      action: 'process_data',
      data: { userId: 123, operation: 'export' },
      timestamp: Date.now()
    };

    console.log('📤 Sending message from frontend client...');
    await client.send('worker.task.data_processing', testMessage);
    console.log('✅ Message sent successfully (acknowledged by backend)');

    // Wait for worker to receive message
    await new Promise(resolve => setTimeout(resolve, 500));

    // 5. Verify results
    console.log('\n📋 Test Results:');
    if (receivedMessages.length > 0) {
      console.log('🎉 SUCCESS! Complete message flow verified:');
      console.log('   Frontend → Backend → RabbitMQ → Worker ✅');
      console.log('\n📦 Received by worker:');
      receivedMessages.forEach((msg, i) => {
        console.log(`   ${i + 1}. Routing Key: ${msg.routingKey}`);
        console.log(`      Payload: ${JSON.stringify(msg.payload)}`);
      });

      // Verify message content
      const received = receivedMessages[0];
      if (received.routingKey === 'worker.task.data_processing' &&
          JSON.stringify(received.payload) === JSON.stringify(testMessage)) {
        console.log('\n✅ Message content verification: PASSED');
      } else {
        console.log('\n❌ Message content verification: FAILED');
      }
    } else {
      console.log('❌ FAILED: No messages received by worker');
    }

    // 6. Test multiple messages
    console.log('\n🧪 Testing multiple messages...');

    const messages = [
      { routingKey: 'worker.task.email', payload: { type: 'email', recipient: 'test@example.com' }},
      { routingKey: 'worker.task.notification', payload: { type: 'push', userId: 456 }},
      { routingKey: 'worker.task.analytics', payload: { type: 'track', event: 'signup' }}
    ];

    const initialCount = receivedMessages.length;

    for (const msg of messages) {
      await client.send(msg.routingKey, msg.payload);
    }

    // Wait for all messages
    await new Promise(resolve => setTimeout(resolve, 1000));

    const newMessages = receivedMessages.slice(initialCount);
    console.log(`✅ Sent ${messages.length} messages, worker received ${newMessages.length}`);

    if (newMessages.length === messages.length) {
      console.log('🎉 Multiple message test: PASSED');
    } else {
      console.log('❌ Multiple message test: FAILED');
    }

    console.log('\n🎉 Manual Worker Integration Test Complete!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    if (client) client.disconnect({ onActiveListeners: 'clear' });
    if (workerChannel) await workerChannel.close();
    if (workerConnection) await workerConnection.close();
    console.log('✅ Cleanup complete');

    process.exit(0);
  }
}

runWorkerIntegrationTest();