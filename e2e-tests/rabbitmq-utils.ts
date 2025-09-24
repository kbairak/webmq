import {
  RabbitMQContainer,
  StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import Docker from 'dockerode';

interface RabbitMQConnection {
  url: string;
  cleanup: () => Promise<void>;
}

let createdContainer: StartedRabbitMQContainer | null = null;

/**
 * Gets a RabbitMQ connection URL, reusing existing containers when possible.
 * Returns both the connection URL and a cleanup function.
 */
export async function getRabbitMQConnection(): Promise<RabbitMQConnection> {
  // First, check if there's already a running RabbitMQ container
  const existingContainer = await findExistingRabbitMQContainer();

  if (existingContainer) {
    // Reusing existing RabbitMQ container
    return {
      url: `amqp://guest:guest@localhost:${existingContainer.port}`,
      cleanup: async () => {
        // No cleanup needed for existing containers - we didn't create them
        // Skipping cleanup for existing container
      },
    };
  }

  // No existing container found, create a new one
  // Starting new RabbitMQ testcontainer
  const container = await new RabbitMQContainer('rabbitmq:3.11').start();
  createdContainer = container;

  return {
    url: container.getAmqpUrl(),
    cleanup: async () => {
      if (createdContainer) {
        // Stopping created RabbitMQ testcontainer
        await createdContainer.stop();
        createdContainer = null;
      }
    },
  };
}

/**
 * Finds an existing RabbitMQ container that's already running
 */
async function findExistingRabbitMQContainer(): Promise<{
  name: string;
  port: number;
} | null> {
  try {
    const docker = new Docker();
    const containers = await docker.listContainers({ all: false }); // Only running containers

    for (const containerInfo of containers) {
      // Check if this is a RabbitMQ container
      if (isRabbitMQContainer(containerInfo)) {
        const amqpPort = extractAMQPPort(containerInfo);
        if (amqpPort) {
          // Verify the container is actually responding
          if (await isRabbitMQHealthy(amqpPort)) {
            return {
              name:
                containerInfo.Names[0]?.replace('/', '') ||
                containerInfo.Id.slice(0, 12),
              port: amqpPort,
            };
          }
        }
      }
    }
  } catch (error: any) {
    // Could not check for existing RabbitMQ containers
  }

  return null;
}

/**
 * Checks if a container info object represents a RabbitMQ container
 */
function isRabbitMQContainer(containerInfo: any): boolean {
  const image = containerInfo.Image?.toLowerCase() || '';
  const names = containerInfo.Names?.join(' ').toLowerCase() || '';

  return (
    image.includes('rabbitmq') ||
    names.includes('rabbitmq') ||
    containerInfo.Labels?.['org.testcontainers.version'] // Testcontainer label
  );
}

/**
 * Extracts the AMQP port (5672) from container port mappings
 */
function extractAMQPPort(containerInfo: any): number | null {
  const ports = containerInfo.Ports || [];

  for (const port of ports) {
    if (port.PrivatePort === 5672 && port.PublicPort && port.IP === '0.0.0.0') {
      return port.PublicPort;
    }
  }

  return null;
}

/**
 * Checks if RabbitMQ is responding on the given port
 */
async function isRabbitMQHealthy(port: number): Promise<boolean> {
  try {
    const amqplib = await import('amqplib');
    const connection = await amqplib.connect(
      `amqp://guest:guest@localhost:${port}`
    );
    await connection.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Global cleanup function to stop any containers we created
 */
export async function cleanupRabbitMQ(): Promise<void> {
  if (createdContainer) {
    // Global cleanup: Stopping created RabbitMQ testcontainer
    await createdContainer.stop();
    createdContainer = null;
  }
}

// Ensure cleanup happens on process exit
process.on('SIGINT', async () => {
  await cleanupRabbitMQ();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await cleanupRabbitMQ();
  process.exit(0);
});

process.on('beforeExit', async () => {
  await cleanupRabbitMQ();
});
