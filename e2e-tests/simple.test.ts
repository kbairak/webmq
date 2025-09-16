import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

describe('Simple Testcontainers Test', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    console.log('Starting RabbitMQ container...');
    container = await new GenericContainer('rabbitmq:3.11-management')
      .withExposedPorts(5672, 15672)
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: 'guest',
        RABBITMQ_DEFAULT_PASS: 'guest'
      })
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    console.log('Container started successfully!');
  });

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('should start RabbitMQ container successfully', async () => {
    const rabbitmqPort = container.getMappedPort(5672);
    expect(rabbitmqPort).toBeGreaterThan(0);

    console.log(`RabbitMQ is running on port ${rabbitmqPort}`);
  });
});