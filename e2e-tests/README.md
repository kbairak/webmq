# E2E Tests with Optimized RabbitMQ Container Management

## Overview

The e2e tests now use an optimized RabbitMQ container management system that significantly reduces test startup time by reusing existing containers when possible.

## RabbitMQ Container Utility

The `rabbitmq-utils.ts` module provides intelligent container management:

### Features

✅ **Container Reuse**: Automatically detects and reuses existing RabbitMQ containers
✅ **Smart Fallback**: Creates new testcontainer only if none exists
✅ **Automatic Cleanup**: Stops containers only if they were created by the utility
✅ **Health Checking**: Verifies container connectivity before reuse
✅ **Process Safety**: Handles cleanup on process exit/interruption

### Performance Improvement

- **Before**: ~30 seconds per test run (full container startup)
- **After**: ~1-3 seconds when reusing existing container
- **90%+ time reduction** when development RabbitMQ is already running

### Usage

```typescript
import { getRabbitMQConnection } from './rabbitmq-utils';

// Get connection (reuses existing or creates new)
const { url, cleanup } = await getRabbitMQConnection();

// Use the connection
const connection = await amqplib.connect(url);

// Cleanup when done (only stops if we created it)
await cleanup();
```

### Container Detection Logic

The utility checks for existing RabbitMQ containers by:

1. **Docker API inspection**: Uses `dockerode` to list running containers
2. **Image/name matching**: Identifies containers with `rabbitmq` in image or name
3. **Port extraction**: Finds AMQP port (5672) mappings
4. **Health verification**: Tests actual AMQP connectivity

### Cleanup Behavior

- **Existing containers**: No cleanup performed (leaves them running)
- **Created containers**: Full cleanup (stops and removes container)
- **Process interruption**: Automatic cleanup via signal handlers

## Dependencies Added

```json
{
  "dockerode": "^4.0.2",
  "@types/dockerode": "^3.3.23"
}
```

## Environment Scenarios

### Development (docker-compose running)
- ✅ Reuses `webmq-rabbitmq-1` container
- ✅ Tests start in ~1-3 seconds
- ✅ No cleanup needed

### CI/GitHub Actions
- ✅ Creates fresh testcontainer
- ✅ Full isolation between test runs
- ✅ Automatic cleanup

### Local testing without docker-compose
- ✅ Creates fresh testcontainer
- ✅ Stops container after tests
- ✅ Clean state for each run

## Example Output

```
♻️  Reusing existing RabbitMQ container: webmq-rabbitmq-1
✅ Test completed in 1.289s

# vs previous behavior:
🚀 Starting new RabbitMQ testcontainer...
✅ Test completed in 32.156s
```

The utility seamlessly handles all scenarios while providing massive performance improvements during development.