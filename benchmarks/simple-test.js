/**
 * Simple test to check if basic emit works
 */
const { WebMQClient } = require('./utils/client');

async function simpleTest() {
  console.log('🔍 Testing basic emit functionality...');

  const client = new WebMQClient('ws://localhost:8080');

  client.on('error', (error) => console.log('❌ Client error:', error.message));
  client.on('disconnected', () => console.log('🔌 Client disconnected'));

  try {
    console.log('📡 Connecting...');
    await client.connect();
    console.log('✅ Connected');

    // Just try a simple emit without listen
    console.log('📤 Sending simple message...');
    await client.emit('test.simple', { msg: 'hello world' });
    console.log('✅ Message sent successfully');

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    console.log('🔌 Disconnecting...');
    client.disconnect();
  }
}

simpleTest()
  .then(() => console.log('✅ Simple test completed'))
  .catch((error) => console.error('❌ Simple test error:', error));