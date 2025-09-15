# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

### Key Design Patterns

**Frontend API**: Singleton pattern with topic-based pub/sub
```javascript
import { setup, listen, emit } from 'webmq-frontend';
setup('ws://localhost:8080');
listen('chat.room.1', callback);
emit('chat.room.1', data);
```

**Backend Hooks System**: Middleware-style hooks for authentication, validation, and logging:
- `pre`: Runs before action-specific hooks (ideal for auth)
- `onListen`, `onEmit`, `onUnlisten`: Action-specific hooks
- Context object persists user data across hooks

**Authentication Pattern**: Since WebSockets don't use HTTP headers, auth is handled via an initial `auth` message with tokens, then context is populated for subsequent requests.

### RabbitMQ Integration
- Uses topic exchange by default for flexible routing
- WebSocket messages map to AMQP routing keys
- Backend manages WebSocket ↔ RabbitMQ message translation

## Known Issues

**Critical TypeScript Issue**: The backend package (`packages/backend/src/index.ts`) has persistent TypeScript compilation errors related to `amqplib` type definitions. This prevents:
- Backend TypeScript compilation (`npm run build -w webmq-backend`)
- Running backend tests
- Building from TypeScript source

The runtime JavaScript works correctly (see `examples/basic-chat/backend.js`), but TypeScript source cannot be compiled. This is the primary technical debt to resolve.

**Channel Error Handling**: The backend currently uses a shared RabbitMQ channel for all WebSocket connections without error recovery. In production, we need to implement:
- Channel error handling and automatic recreation
- Connection recovery with exponential backoff
- Graceful degradation when RabbitMQ is unavailable
- Health checks and monitoring

## Development Notes

- RabbitMQ management UI available at http://localhost:15672 (guest/guest)
- Frontend uses ESBuild, backend uses TypeScript compiler
- All packages support Jest testing framework
- Examples use Vite for frontend development server