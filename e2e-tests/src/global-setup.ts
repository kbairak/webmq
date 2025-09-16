import { GlobalTestSetup } from './test-setup-global';

export default async (): Promise<void> => {
  const globalSetup = GlobalTestSetup.getInstance();
  await globalSetup.startRabbitMQ();
};