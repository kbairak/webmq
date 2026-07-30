# Examples

All examples are in the [`examples/`](https://github.com/kbairak/webmq/tree/main/examples) directory of the monorepo.

## Basic Chat

A real-time chat app in under 30 lines. React frontend with Node.js backend. The simplest way to see WebMQ in action.

```
cd examples/basic-chat
npm run start
```

**Key concepts:** connect, listen, publish, topic routing

## City Search

A multi-source search app that demonstrates WebMQ's fan-out pattern. Search for any city and get weather, Wikipedia, and image results — each from an independent worker.

```
cd examples/city-search
npm run start
```

Frontend publishes a search request → RabbitMQ fans out to 3+ workers → each publishes results independently → frontend displays them as they arrive.

**Key concepts:** fan-out, cross-language workers, dynamic listen/unlisten per request

Approach: Docker Compose for RabbitMQ, `concurrently` for server + workers + frontend.

## Mobile Chat

An Expo/React Native chat app that interoperates with the `basic-chat` web example — they share the same RabbitMQ exchange and routing keys.

```
cd examples/mobile-chat
npm run start
```

**Key concepts:** React Native, Hermes polyfills, AppState reconnection, cross-platform interop

## Todos

A collaborative todo app with user selection, real-time sync across multiple browser tabs.

```
cd examples/todos
npm run start
```

**Key concepts:** multi-component React app, user context, real-time state sync

## Python Worker (React + Python)

Shows a cross-language worker pattern: Node.js backend + React frontend + Python worker using `aio_pika` (async AMQP library).

```
cd examples/react-python-worker
# See the README for setup instructions
```

**Key concepts:** cross-language workers, Python AMQP integration

---

## Quick reference

| Example | Frontend | Backend | Workers | Start command |
|---|---|---|---|---|
| basic-chat | React 19 | Node.js | — | `npm run start` |
| city-search | React | Node.js | 3+ Node.js workers | `npm run start` |
| mobile-chat | Expo/RN | Node.js | — | `npm run start` |
| todos | React | Node.js | — | `npm run start` |
| react-python-worker | React | Node.js | Python (aio_pika) | See README |

## Running examples

The examples are part of the monorepo and reference the source packages directly (via npm file: dependencies or vite aliases). No need to publish packages first — just clone and run.

```bash
git clone https://github.com/kbairak/webmq.git
cd webmq
npm install
# Then cd into any example and run
cd examples/city-search
npm run start
```

Most examples use [testcontainers](https://node.testcontainers.org/) to automatically start RabbitMQ in Docker. The `city-search` example uses `docker-compose` instead (for long-running development).
