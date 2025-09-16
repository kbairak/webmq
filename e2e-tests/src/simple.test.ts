import { describe, test, expect } from '@jest/globals';
import { GlobalTestSetup } from './test-setup-global';

describe('Simple Testcontainers Test', () => {
  test('should use in-memory AMQP mock successfully', async () => {
    const globalSetup = GlobalTestSetup.getInstance();
    const rabbitmqUrl = await globalSetup.getRabbitMQUrl();

    expect(rabbitmqUrl).toBeDefined();
    expect(rabbitmqUrl).toMatch(/^amqp:\/\/mock:mock@localhost:\d+$/);

    const portMatch = rabbitmqUrl.match(/:([0-9]+)$/);
    const rabbitmqPort = portMatch ? parseInt(portMatch[1]) : 0;
    expect(rabbitmqPort).toBeGreaterThan(0);

    console.log(`🚀 Using in-memory AMQP mock on port ${rabbitmqPort}`);
  });
});