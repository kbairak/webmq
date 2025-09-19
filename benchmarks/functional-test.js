/**
 * Working test with proper timing for listen-emit flow
 */
const { WebMQClient } = require('./utils/client');

async function workingTest() {
  console.log('🔍 Testing working emit-listen flow...');

  const client1 = new WebMQClient('ws://localhost:8080');
  const client2 = new WebMQClient('ws://localhost:8080');

  // Add error logging
  client1.on('error', (error) =>
    console.log('❌ Client1 error:', error.message)
  );
  client2.on('error', (error) =>
    console.log('❌ Client2 error:', error.message)
  );
  client1.on('disconnected', () => console.log('🔌 Client1 disconnected'));
  client2.on('disconnected', () => console.log('🔌 Client2 disconnected'));

  try {
    // Connect clients
    console.log('📡 Connecting clients...');
    await client1.connect();
    await client2.connect();
    console.log('✅ Both clients connected');

    // Wait after connection
    console.log('⏳ Waiting 3 seconds after connection...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Set up listener on client2
    console.log('👂 Setting up listener on client2...');
    let messagesReceived = 0;

    await client2.listen('test.topic', (payload) => {
      messagesReceived++;
      console.log(`📨 Client2 received message ${messagesReceived}:`, payload);
    });
    console.log('✅ Listener set up');

    // Wait for subscription to be fully established
    console.log('⏳ Waiting 5 seconds for subscription to be established...');
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Send messages from client1
    console.log('📤 Sending messages from client1...');
    for (let i = 1; i <= 3; i++) {
      const payload = { test: `message ${i}`, timestamp: Date.now() };
      console.log(`📤 Sending message ${i}:`, payload);
      await client1.emit('test.topic', payload);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait between messages
    }

    // Wait for messages to be processed
    console.log('⏳ Waiting 3 seconds for messages to be processed...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log(
      `\\n📊 Results: ${messagesReceived} messages received out of 3 sent`
    );
  } catch (error) {
    console.error('❌ Working test failed:', error.message);
  } finally {
    console.log('🔌 Disconnecting...');
    client1.disconnect();
    client2.disconnect();
  }
}

// Run the working test
workingTest()
  .then(() => console.log('✅ Working test completed'))
  .catch((error) => console.error('❌ Working test error:', error));
