# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Programming guidelines

- Avoid unnecessary abstractions
  - If a typescript type/interface is to be used only once, just inline it
  - If a function or class is to be used only once, be very in favor of inlining it; keep it separate only if you are very confident that the name of the function explains its purpose well and that if one reads the function in isolation, they will be able to understand what it does
- When following general instructions, apply them both on the backend and the frontend. If it's not clear from the request whether it applies to both, ask for clarification
- After every change, run the tests (including e2e-tests) to make sure nothing is broken
- After every change to the interface and functionality, remember to edit the Readme
- Offer to commit and push often

## Project Overview

WebMQ is a framework that bridges web frontends with RabbitMQ message brokers using WebSockets for real-time bidirectional communication. It's a monorepo with two main packages (`webmq-backend` and `webmq-frontend`) and example applications.

## Development Commands

### Prerequisites Setup

```bash
# Start RabbitMQ (required for development)
docker-compose up -d

# Install all dependencies and link workspaces
npm install
```

### Build Commands

```bash
# Build all packages
npm run build

# Build specific packages
npm run build:backend
npm run build:frontend
npm run build -w webmq-backend    # Alternative syntax
npm run build -w webmq-frontend   # Alternative syntax
```

### Development & Testing

```bash
# Run tests in individual packages
npm run test -w webmq-backend
npm run test -w webmq-frontend

# Run end-to-end tests
cd e2e-tests && npm test

# Development builds with watch mode
npm run dev -w webmq-backend     # TypeScript watch mode
npm run dev -w webmq-frontend    # ESBuild watch mode
```

### Running Examples

```bash
# Start basic-chat example (both backend and frontend)
npm run start:chat

# Or start components separately:
npm run start:backend -w basic-chat  # Backend on ws://localhost:8080
npm run start:frontend -w basic-chat # Vite dev server
```

## Architecture

### Monorepo Structure

- **`packages/backend/`**: Node.js WebSocket server library that connects to RabbitMQ
- **`packages/frontend/`**: Framework-agnostic client library providing `setup()`, `emit()`, `listen()`, `unlisten()` API
- **`examples/basic-chat/`**: Demo chat application showing real-time communication
- **`e2e-tests/`**: End-to-end integration tests using real WebSocket and RabbitMQ connections

### Recent Architectural Improvements (2024)

**Enhanced Backend Architecture**:

- **WebSocketManager**: Centralized WebSocket connection lifecycle management with built-in RabbitMQ integration
- **RabbitMQManager**: Dedicated AMQP operations handler with subscription management
- **Streamlined Message Processing**: Replaced strategy pattern with direct switch/case logic for better maintainability
- **Always-Durable Exchanges**: RabbitMQ exchanges are now always durable for better reliability

**Type-Safe Message Hierarchy**:

```typescript
Message (base)
├── OutgoingMessage (client → server)
│   ├── ListenMessage, UnlistenMessage, EmitMessage, IdentifyMessage
└── IncomingMessage (server → client)
    ├── DataMessage, AckMessage, NackMessage, ErrorMessage
```

**Complete Acknowledgment System**:

- Frontend generates unique messageIds and returns promises
- Backend sends ack/nack responses for all publish operations
- Full integration with message queuing and reconnection logic
- Comprehensive error handling with proper acknowledgments

### Key Design Patterns

**Frontend API**: Singleton pattern with topic-based pub/sub and promise-based acknowledgments

```javascript
import { setup, listen, emit } from 'webmq-frontend';
setup('ws://localhost:8080');
listen('chat.room.1', callback);

// Promise-based publishing with acknowledgments
const result = await emit('chat.room.1', data);
```

**Backend Hooks System**: Middleware-style hooks for authentication, validation, and logging:

- `pre`: Runs before action-specific hooks (ideal for auth)
- `onListen`, `onPublish`, `onUnlisten`: Action-specific hooks
- Context object persists user data across hooks

**Authentication Pattern**: Since WebSockets don't use HTTP headers, auth is handled via an initial `identify` message with session tokens, then context is populated for subsequent requests.

### RabbitMQ Integration

- Uses durable topic exchanges for reliable message routing
- WebSocket messages map to AMQP routing keys with wildcard support
- Backend manages WebSocket ↔ RabbitMQ message translation
- Automatic subscription cleanup on client disconnect

## Development Notes

- RabbitMQ management UI available at <http://localhost:15672> (guest/guest)
- Frontend uses ESBuild, backend uses TypeScript compiler
- All packages support Jest testing framework with 104 total tests
- Examples use Vite for frontend development server
- E2E tests use optimized RabbitMQ container reuse for faster testing

## Production Considerations

**Channel Error Handling**: The backend uses a shared RabbitMQ channel for all WebSocket connections. For production, consider implementing:

- Channel error handling and automatic recreation
- Connection recovery with exponential backoff
- Graceful degradation when RabbitMQ is unavailable
- Health checks and monitoring

**Scaling**: The current architecture supports horizontal scaling with proper session management and RabbitMQ clustering.
