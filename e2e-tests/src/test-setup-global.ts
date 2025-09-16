export class GlobalTestSetup {
  private static instance: GlobalTestSetup;
  private mockAmqpUrl: string = 'amqp://mock:mock@localhost:5672';
  private initialized: boolean = false;

  private constructor() {}

  static getInstance(): GlobalTestSetup {
    if (!GlobalTestSetup.instance) {
      GlobalTestSetup.instance = new GlobalTestSetup();
    }
    return GlobalTestSetup.instance;
  }

  async startRabbitMQ(): Promise<string> {
    if (this.initialized) {
      return this.mockAmqpUrl;
    }

    console.log('🚀 Starting in-memory AMQP mock (ultra-fast)...');

    // Just mark as initialized - no actual container to start
    this.initialized = true;

    console.log('🚀 In-memory AMQP mock ready');

    return this.mockAmqpUrl;
  }

  async getRabbitMQUrl(): Promise<string> {
    if (!this.initialized) {
      await this.startRabbitMQ();
    }
    return this.mockAmqpUrl;
  }

  getRabbitMQUrlSync(): string {
    if (!this.initialized) {
      throw new Error('AMQP mock not started. Call startRabbitMQ() first.');
    }
    return this.mockAmqpUrl;
  }

  async stopRabbitMQ(): Promise<void> {
    if (this.initialized) {
      console.log('🚀 Stopping in-memory AMQP mock...');
      this.initialized = false;
      console.log('🚀 In-memory AMQP mock stopped');
    }
  }

  isRunning(): boolean {
    return this.initialized;
  }
}

// Helper function to get unique exchange name for test isolation
export function getTestExchangeName(testSuiteName: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `test_${testSuiteName}_${timestamp}_${random}`;
}