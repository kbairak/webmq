import { GlobalTestSetup } from './test-setup-global';

export default async (): Promise<void> => {
  const globalSetup = GlobalTestSetup.getInstance();
  await globalSetup.stopRabbitMQ();

  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  // Give time for async cleanup to complete
  await new Promise(resolve => setTimeout(resolve, 1000));
};