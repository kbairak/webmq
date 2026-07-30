# Contributing

## Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm 7+

## Development setup

```bash
# Clone the repo
git clone https://github.com/kbairak/webmq.git
cd webmq

# Install dependencies
npm install

# Build all packages
npm run build
```

## Project structure

```
packages/
├── protocol/    # Shared wire protocol (binary bundle format, types, message constructors)
├── backend/     # Node.js WebSocket server library
└── frontend/    # Framework-agnostic client library

examples/
├── basic-chat/  # Simple chat application
├── city-search/ # Multi-source search with workers
├── mobile-chat/ # Expo/React Native chat
├── todos/       # Collaborative todo app
└── react-python-worker/  # Cross-language worker demo

e2e-tests/       # Integration tests (in progress)
benchmarks/      # Performance benchmarking suite
```

## Development commands

```bash
# Build specific packages
npm run build -w webmq-protocol
npm run build -w webmq-backend
npm run build -w webmq-frontend

# Run tests
npm run test -w webmq-protocol
npm run test -w webmq-backend
npm run test -w webmq-frontend
npm test  # Run e2e tests

# Development mode (watch)
npm run dev -w webmq-backend    # TypeScript watch
npm run dev -w webmq-frontend   # ESBuild watch
```

## Running an example

```bash
# Start RabbitMQ (if not using testcontainers)
docker-compose up -d

# Build packages first
npm run build

# Start an example
npm run start:chat       # basic-chat
# or cd into the example directory
cd examples/city-search && npm run start
```

## Documentation

Docs are built with [mkdocs-material](https://squidfunk.github.io/mkdocs-material/).

```bash
pip install mkdocs-material
mkdocs serve  # Live preview at http://localhost:8000
```

The RabbitMQ management UI is available at [http://localhost:15672](http://localhost:15672) (guest/guest).

## Guidelines

- Match the existing code style (Prettier config included)
- Add tests for new features
- Update docs when changing APIs
- Use conventional commit messages

## Architecture notes

- The wire protocol (`webmq-protocol`) must be kept in sync between frontend and backend — it defines how messages are serialized over the WebSocket
- Frontend hooks are synchronous header transformers; backend hooks are async header transformers
- The frontend ships polyfills for `EventTarget`, `CustomEvent`, `TextEncoder`, etc. for React Native / Hermes compatibility
