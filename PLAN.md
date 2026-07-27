# PLAN: Fix disconnection detection & message delivery on mobile

## Audience

This plan is written for an LLM implementer. It assumes familiarity with TypeScript,
WebSockets (`ws` on the server, browser `WebSocket` on the client) and RabbitMQ (`amqplib`).
Work only in `packages/frontend/src`, `packages/backend/src` and their `tests/` folders.
Do not touch `examples/`, `benchmarks/`, `e2e-tests/` except where explicitly stated.

## Important: README vs. source divergence

The README describes an aspirational API (`setup()`/`listen()`/`publish()` standalone
functions, Promise-returning `publish` with ACKs, EventEmitter `'connected'` /
`'disconnected'` / `'reconnecting'` events, Express-style `context/next` hooks).
**The actual source does not implement most of this.** Do NOT rewrite the whole API to
match the README. Implement only what this plan specifies; the plan deliberately moves
the source closer to the README only where it fixes the mobile issues.

Current real API (source of truth):

- Frontend (`packages/frontend/src/index.ts`): default-export class `WebMQClient`
  with constructor `{ url, sessionId, reconnectDelays?, logLevel? }`, methods
  `connect()`, `disconnect()`, `publish()` (returns `void`), `listen()`, `unlisten()`,
  `listenRaw()`, `listenJson()`, `addHook()` / `removeHook()` (synchronous hooks that
  transform a header object and must return it).
- Frontend transport (`packages/frontend/src/ReconnectingWebSocket.ts`): an
  `EventTarget` wrapping a browser `WebSocket`, re-dispatching `open`, `close`,
  `error`, `message` events plus custom `reconnecting` / `reconnected` events.
- Backend (`packages/backend/src/index.ts`): default-export class `WebMQServer`,
  options `{ rmqUrl, exchange, port, healthEndpoint?, metricsEndpoint?, queueTimeout?, logLevel? }`,
  async hooks `(header, context, rmqMessage?) => header`, per-WebSocket serial
  processing queue (`this._queues`), one RabbitMQ queue per `sessionId` with
  `expires` (x-expires) equal to `queueTimeout` (default 5 min).

## Symptoms to fix (from mobile testing)

1. Disconnects are detected late or never (network switch WiFi↔cellular, airplane
   mode, tab backgrounded/foregrounded, OS killing the radio).
2. Messages published while (unknowingly) disconnected are lost or duplicated.
3. After a reconnect, incoming messages silently stop arriving.

## Root causes (verified in source)

### Frontend — `packages/frontend/src/index.ts`

- **F1. Offline queue is never cleared after flush.** In `connect()`'s `onOpen`
  (lines ~115-117) the queue is flushed with `this._messageQueue.forEach(...)` but
  the array is never emptied. Every subsequent reconnect re-sends ALL previously
  queued messages → duplicates.
- **F2. `messageId` is regenerated on every send/flush.** `_sendOrEnqueue`
  (lines ~244-248) always assigns a fresh `uuid()`. A queued message re-sent after
  reconnect gets a new ID each time, making duplicate detection impossible.
- **F3. Listeners are never re-established after reconnect.** `onOpen` only sends
  `identify` and flushes the publish queue. If the server-side session queue expired
  (`queueTimeout`) or was deleted, its bindings are gone; the client still believes
  it is subscribed (`_messageListeners` intact) but receives nothing.
- **F4. No detection of half-open connections.** `_sendOrEnqueue` (line ~247) sends
  whenever `readyState === OPEN`. On mobile, TCP connections go half-open for minutes
  while `readyState` stays `OPEN`; messages written to a dead socket are silently
  lost. There is no heartbeat and no use of `online`/`offline`/`visibilitychange`
  browser events.
- **F5. No ACKs at all.** `publish()` returns `void` (lines ~191-199); the server
  never confirms receipt. There is no way to detect that a sent message never
  arrived, hence no retry.
- **F6. `binaryType` is lost after reconnect.** `connect()` sets
  `this._ws.binaryType = 'arraybuffer'` once (line ~90). The setter forwards to the
  *current* inner socket only (`ReconnectingWebSocket.ts` lines ~84-86). After a
  reconnect the inner `WebSocket` is a new object with the default `binaryType`
  `'blob'`; the `message` handler in `index.ts` (line ~128) drops everything that
  is not an `ArrayBuffer` → **all incoming messages are silently discarded after
  any reconnect.** This is likely the single biggest cause of symptom 3.

### Frontend — `packages/frontend/src/ReconnectingWebSocket.ts`

- **F7. Gives up reconnecting after 5 attempts (~15 s total)** (lines ~26-37:
  `reconnectDelays.length` exhausted → dispatches final `close`). Mobile outages
  routinely last longer; the app is then dead forever with no signal to the UI.
- **F8. No way to force-reconnect a half-open socket.** `close()` (lines ~76-79)
  sets `_shouldReconnect = false`, so the client cannot abort a zombie connection
  and trigger the reconnect path.

### Backend — `packages/backend/src/index.ts`

- **B1. No heartbeat.** The server never pings WebSocket clients, so half-open
  (ghost) connections are detected only when TCP eventually times out (many
  minutes). Until then:
  - the ghost consumer stays registered on the session queue; RabbitMQ round-robins
    messages to it; `_handleRmqMessage` (lines ~445-469) fails the `ws.OPEN` check,
    nacks with requeue → redelivery to the same ghost → hot requeue loop, delayed
    delivery to the real (reconnected) client.
- **B2. No dedup of consumers per session.** `_handleIdentify` (lines ~257-294)
  always creates a new consumer. A client reconnecting with the same `sessionId`
  while its ghost is still alive yields two consumers on one queue (see B1).
- **B3. No `ping`/`ack` protocol actions.** The message `switch` (lines ~166-181)
  only knows `identify`/`publish`/`listen`/`unlisten`; there is nothing the client
  can use for heartbeats or delivery confirmation.
- **B4. `publish` uses a non-confirm channel** (line ~320): `channel.publish`
  returns before the broker has accepted the message. Acceptable to keep, but the
  client ACK (see D3) then only means "written to the broker connection", not
  "persisted". Document this; switching to confirm channels is optional (P2).

## Design decisions (implement exactly these)

- **D1. Application-level heartbeat.** Browser WebSockets cannot send protocol-level
  ping frames, so the client sends `{ action: 'ping', messageId }` on an interval
  and the server replies `{ action: 'pong', messageId }`. Client tracks the last
  pong time; if it exceeds a timeout the client force-reconnects (D4).
  Defaults: `pingInterval = 5000` ms, `pongTimeout = 10000` ms. Both configurable
  via new optional `WebMQClientOptions` fields.
- **D2. Server-side WebSocket heartbeat.** Standard `ws` pattern: server tracks an
  `isAlive` flag per socket, sets it on `pong` (protocol-level, `ws.on('pong')`),
  and every `wsPingInterval` (default 15000 ms, configurable via new
  `WebMQServerOptions.wsPingInterval`) calls `ws.ping()` and `ws.terminate()`s
  sockets that did not answer since the previous check. Termination fires the
  existing `close` handler → consumer cancelled; because termination is an abnormal
  closure (no 1000/1001 code) the session queue is NOT deleted → messages remain
  queued for the reconnecting client.
- **D3. ACK protocol (client→server delivery confirmation).** After successfully
  processing `identify`/`publish`/`listen`/`unlisten`, the server sends
  `{ action: 'ack', messageId }` back over the same socket; on failure it sends
  `{ action: 'nack', messageId, error }` instead of just logging. Client keeps
  `pendingAcks: Map<messageId, { header, payload, resolve, reject, timer }>`.
  `publish()`, `listen()`, `unlisten()` return `Promise<void>` resolving on `ack`,
  rejecting on `nack` or after `ackTimeout` ms (default 5000, configurable via
  `WebMQClientOptions.ackTimeout`). ACK/NACK messages bypass the `message` hooks
  and listener dispatch; they are handled internally.
- **D4. Force-reconnect.** Add an internal method to `ReconnectingWebSocket` that
  drops the current inner socket WITHOUT setting `_shouldReconnect = false` (so the
  existing `close`-handler reconnect logic runs). Used by the heartbeat watchdog.
- **D5. Infinite reconnect with capped backoff.** Instead of giving up after
  `reconnectDelays.length` attempts, keep retrying forever, reusing the LAST delay
  in the array as a cap (e.g. `[0, 1000, 2000, 4000, 8000]` → retries forever at
  8 s max). Emit events so apps can react (D7). Do not add jitter in this pass.
- **D6. Correct reconnect flush sequence** in `WebMQClient`'s `onOpen`/`reconnected`
  handler: (1) send `identify`; (2) re-send `listen` for every key currently in
  `_messageListeners` (fixes F3); (3) flush the offline queue by first COPYING it
  and clearing the original, then sending each entry with its ORIGINAL `messageId`
  (fixes F1, F2). Bind/unbind operations are idempotent server-side, so duplicates
  between steps (2) and (3) are harmless.
- **D7. Connection events.** Make `WebMQClient` an `EventTarget` (or wrap one) and
  dispatch: `'connected'` (first open), `'reconnecting'` (retry scheduled, detail:
  attempt number), `'reconnected'` (open after ≥1 attempt), `'disconnected'`
  (connection lost / watchdog fired), `'error'`. This is a minimal subset of what
  the README already advertises; implement with `EventTarget` + `CustomEvent`,
  not Node's `EventEmitter`.
- **D8. Browser lifecycle integration.** In `connect()` (guard with
  `typeof window !== 'undefined'` / `typeof document !== 'undefined'`):
  - on `window` `'online'` → if socket not `OPEN` or pong stale, force-reconnect now;
  - on `document` `'visibilitychange'` → when visible, run the same staleness check.
  Register these listeners once per `WebMQClient` instance (not per `connect()`
  call) and remove them in `disconnect()`. Same for the existing `beforeunload`
  handler, which currently accumulates on every `connect()` call.
- **D9. Pending-ack recovery.** When the socket closes (any reason), move every
  entry of `pendingAcks` back to the FRONT of the offline queue (preserving order
  and original `messageId`s) and clear their timers; they will be re-sent by D6 →
  at-least-once delivery. Do NOT add server-side messageId dedup in this pass
  (listed as P2 follow-up); document that publishes may be duplicated across
  reconnects in rare races.
- **D10. One consumer per session.** Server keeps `_sessions: Map<sessionId, { ws, consumerTag }>`.
  In `_handleIdentify`, if a session already exists on a DIFFERENT socket: cancel
  the old consumer and `terminate()` the old socket (its `close` handler will do
  the rest of the cleanup). Also delete the old entry from `_consumerTags`/
  `_sessions` carefully so the old socket's `close` handler does not cancel the
  NEW consumer (guard the cleanup in the `close` handler by checking that the
  stored consumerTag/ws still belongs to that socket).
- **D11. End-to-end ACK for server→client delivery (RMQ ack only after client ack).**
  Today the server calls `channel.ack(rmqMessage)` immediately after `ws.send()`
  (`_handleRmqMessage`, lines ~457-463), so a message written into a dying socket
  is lost for good. Change to a two-way protocol:
  - Server attaches a fresh `messageId` (uuid) to the header of every message it
    forwards to a client (header already carries `routingKey`; add `messageId`).
  - Client, after successfully dispatching an incoming message to its listeners,
    sends `{ action: 'ack', messageId }` back over the socket. This client→server
    `ack` is a NEW action in the server-side message switch; it bypasses all
    server hooks and is handled internally.
  - Server keeps `_pendingRmqAcks: Map<messageId, { rmqMessage, channel, ws, timer }>`.
    On receiving the client `ack`: `channel.ack(rmqMessage)` + remove entry.
    On timeout (new option `clientAckTimeout`, default 10000 ms) or when that
    socket closes/terminates: `channel.nack(rmqMessage, false, true)` (requeue) +
    remove entry. Requeued messages stay in the session queue and are redelivered
    to the live/reconnected consumer → at-least-once end-to-end.
  - Do NOT block the per-socket serial processing chain (`_queues`) while waiting
    for the client ack: send the message, register the pending entry, and let the
    chain continue. Ack/nack happens asynchronously. (Consequence: a requeued
    message may be redelivered out of order relative to later messages — accepted,
    document it.)
  - Client MUST send the `ack` even if a user hook or callback throws (catch,
    log locally, still ack). Otherwise a poison message would redeliver forever.
    The reverse ACK protects against transport loss only, not application errors.
  - Client `ack` messages themselves are fire-and-forget (no ack-of-ack, no
    retransmit). If the ack is lost, the server timeout nacks+requeues and the
    client receives a duplicate → consumers must tolerate duplicates (document).

## Implementation steps (in order)

### Step 1 — Shared protocol package (`packages/protocol`, name `webmq-protocol`)

Single source of truth for the wire protocol. Pure functions + types only — NO
classes, NO I/O, NO ack state machines (those stay explicit in each package).

**Contents:**

1. `src/bundle.ts` — single `bundleData`/`unbundleData`, hardened superset of the
   two current copies (frontend `src/bundle.ts`, backend `src/utils.ts`):
   - payload type `ArrayBuffer | Uint8Array` (covers Node `Buffer` without
     referencing the `Buffer` global — must stay browser-safe);
   - `unbundleData` accepts `ArrayBuffer | Uint8Array` and respects
     `byteOffset`/`byteLength` (fixes latent bug: backend currently casts ws
     `Buffer` → `ArrayBuffer`, which is wrong when the Buffer is a view onto a
     pooled allocation with a nonzero offset);
   - keep the backend's 1 MB header-length guard (frontend gains it).
2. `src/types.ts` — `Action` union literal type
   (`'identify' | 'publish' | 'listen' | 'unlisten' | 'ping' | 'pong' | 'ack' | 'nack' | 'message'`),
   `ClientMessageHeader`, `ServerMessageHeader`, `MessageHeader`. Both packages
   import from here and delete their local copies.
3. `src/messages.ts` — pure constructors `makePing` / `makePong` / `makeAck` /
   `makeNack` and type guards `isPong` / `isAck` / `isNack(header)`. Both sides use
   these in their switch/handlers — exactly one spelling of the protocol.
4. `src/id.ts` — `newMessageId()` wrapping `uuid` v4 (uuid works in browsers and
   Node). The backend needs server-generated messageIds for D11 anyway; this avoids
   adding a direct uuid dependency to backend. `uuid` becomes a dependency of the
   protocol package only; frontend drops its direct dep.
5. `src/index.ts` — re-exports only.

**Package config:**

- `package.json`: `"type": "module"`, `main`/`types` → `dist`, `exports` map with
  `types`/`import`/`require` conditions, `private: true` (NOTE: if
  frontend/backend are ever published to npm, `webmq-protocol` must be published
  too — flag this in the README), script `build: tsc`, dependency `uuid`,
  devDependencies `typescript` (+ `jest`, `ts-jest`, `@types/jest`, `@types/uuid`
  if testing inside the package, matching the versions used by the other packages).
- `tsconfig.json`: extends root `tsconfig.json`, `module: ESNext`,
  `moduleResolution: node`, `outDir: dist`, declarations on, `include: ["src"]`.
- ALL relative imports inside protocol src use explicit `.js` extensions —
  required for Node ESM consumers, harmless for esbuild and ts-jest.

**Consumer changes:**

- Frontend: delete `src/bundle.ts`; all bundle/type imports come from
  `webmq-protocol`. esbuild bundles the workspace dependency automatically.
- Backend: remove `bundleData`/`unbundleData` from `src/utils.ts` (KEEP `retry`
  there); imports come from `webmq-protocol`.
- Both `jest.config.cjs` files: add
  `moduleNameMapper: { '^webmq-protocol$': '<rootDir>/../protocol/src/index.ts' }`
  so ts-jest transforms the TS source directly (avoids ESM-dist-under-jest issues
  and removes any build-before-test requirement).
- Root `package.json`: add a `build:protocol` script. Root `build` runs
  `npm run build --workspaces`; npm orders workspace scripts topologically, so
  protocol builds first — VERIFY this during implementation (`npm run build` from
  a clean state); if the order is wrong, chain the build scripts explicitly.
- Run `npm install` at the repo root after creating the package to wire the
  workspace symlink.

**Tests:** `packages/protocol/tests/bundle.test.ts` — round-trip,
Buffer-with-nonzero-offset input, oversized-header rejection, and a golden-vector
test (fixed header + payload → exact expected bytes) to lock the wire format
against accidental drift. Check for existing bundle tests in frontend/backend and
move/adapt them here.

**Gate:** Step 1 is a pure refactor — all existing frontend and backend tests must
still pass with zero behaviour change before proceeding.

### Step 2 — Frontend transport (`ReconnectingWebSocket.ts`)

1. Store the desired `binaryType` in a private field when the setter is called and
   apply it to every new inner socket inside `_connect()` (fixes F6).
2. Implement D5: replace the give-up condition with capped infinite retry. Keep
   dispatching `reconnecting` before every retry (include attempt number via
   `CustomEvent` detail); keep the final `close` dispatch only when
   `_shouldReconnect === false`.
3. Add `public forceReconnect(): void` (D4): if an inner socket exists, close it
   with code `4000` (private-use code, reason `'force reconnect'`) without touching
   `_shouldReconnect`; if a reconnect timer is currently sleeping, skip the wait
   (store the timer handle so it can be cleared).
4. Make the reconnect sleep cancellable: store `setTimeout` id, clear it in
   `forceReconnect()` and `close()`, and re-check `_shouldReconnect` after the
   sleep before calling `_connect()`.
5. Update/extend `packages/frontend/tests/ReconnectingWebSocket.test.ts` for:
   binaryType persistence across reconnect, infinite retry with cap,
   forceReconnect behaviour, cancelled sleep on close. Use fake timers
   (jest.useFakeTimers) — check existing test style first and follow it.

### Step 3 — Frontend client (`index.ts`)

Import `bundleData`/`unbundleData`, message types, and the `messages.ts`
constructors/guards from `webmq-protocol` (done in Step 1; use them here for all
new protocol messages — no hand-written `{ action: '...' }` literals).

1. Constructor: accept and store new options `pingInterval` (5000), `pongTimeout`
   (10000), `ackTimeout` (5000). Keep existing options unchanged.
2. `_sendOrEnqueue`: stop regenerating `messageId` if the header already has one;
   only assign `uuid()` when absent (fixes F2). When the socket is OPEN, register
   the message in `pendingAcks` (with timeout timer rejecting after `ackTimeout`)
   and return/chain the Promise; when not OPEN, push `{ header, payload }` onto the
   queue (no Promise settlement yet — settle only after the eventual ACK; document
   that publishing while offline yields a Promise that resolves after reconnect).
3. `publish` / `listen` / `unlisten`: return `Promise<void>` backed by `pendingAcks`
   (D3). `listen`/`unlisten` still mutate `_messageListeners` synchronously as
   today; the Promise only tracks the wire ACK.
4. In the `message` handler, before anything else: if `header.action === 'pong'`
   → update `lastPongAt`, resolve nothing, return. If `'ack'`/`'nack'` → settle the
   matching `pendingAcks` entry (clear timer), return. Neither goes through hooks
   or listener dispatch.
5. Reverse ACK for incoming messages (D11): after an incoming data message (header
   has `routingKey` and server-assigned `messageId`) has been dispatched through
   hooks and listener callbacks, send `{ action: 'ack', messageId }` back. Wrap
   the whole dispatch in try/catch: on any error, log and STILL send the ack
   (poison-message protection, see D11). Send directly via the socket, bypassing
   `pendingAcks` and the offline queue — if the socket is not OPEN, skip silently
   (server-side timeout will nack+requeue).
6. Heartbeat (D1): start a `pingInterval` timer on open/reconnected; on each tick,
   if `Date.now() - lastPongAt > pongTimeout` → log + `forceReconnect()`; else send
   `{ action: 'ping', messageId: uuid() }`. Clear the timer on close/disconnect.
   Initialize `lastPongAt = Date.now()` on every successful open (grace for the
   first interval).
7. Reconnect flush sequence exactly as D6; re-listen step reuses the same internal
   send path but must NOT re-run `listen` user hooks a second time for already-active
   listeners — send the wire message directly (pre/post hooks still run).
8. On socket `close` event: perform D9 (pending → front of queue), stop heartbeat
   timer, dispatch `'disconnected'` (D7).
9. Dispatch D7 events at the right places: `connected` on first open, `reconnected`
   on subsequent opens, `reconnecting` (pass-through from transport, with attempt
   number), `error` pass-through.
10. Browser lifecycle listeners per D8, registered once, removed in `disconnect()`.
11. Extend `packages/frontend/tests/index.test.ts`: queue cleared after flush (no
    duplicates on second reconnect), messageId stable across resend, re-listen
    after reconnect, ack resolves publish, nack rejects, ack timeout rejects,
    pending-ack requeue on close, pong timeout triggers forceReconnect, incoming
    message triggers a client→server `ack` reply (including when a callback throws). Mock
    WebSocket as the existing tests do — read `tests/utils.ts`/`tests/setup.ts`
    and reuse their mocks.

### Step 4 — Backend (`index.ts`)

Use `bundleData`/`unbundleData` and the `messages.ts` constructors/guards from
`webmq-protocol` for all new protocol traffic (pong/ack/nack) — no hand-written
`{ action: '...' }` literals.

1. Message `switch`: add `case 'ping'` → immediately `ws.send(bundleData({ action: 'pong', messageId: header.messageId }))`;
   no hooks, no RabbitMQ interaction (D1). Unknown actions keep current behaviour.
2. ACK/NACK (D3): in the per-socket processing chain, after each action handler
   succeeds, send `{ action: 'ack', messageId }`; in the existing `catch`, send
   `{ action: 'nack', messageId, error: String(err) }` in addition to logging.
   Guard sends with `ws.readyState === ws.OPEN`. Never ACK a `'ping'` twice (ping
   replies pong only, no ack).
3. Server heartbeat (D2): on connection, set `isAlive = true` on the socket;
   `ws.on('pong', () => isAlive = true)`. One shared `setInterval` per server
   instance (created in `start()`, cleared in `stop()`): for each socket, if
   `!isAlive` → `ws.terminate()`, else `isAlive = false; ws.ping()`. Interval from
   new option `wsPingInterval` (default 15000).
4. Session dedup (D10): add `_sessions` map; implement the
   identify-time ghost eviction and the guarded cleanup in the `close` handler as
   specified. Update `_handleIdentify` to store `{ ws, consumerTag }` after
   consuming.
5. Reverse ACK, server side (D11): rework `_handleRmqMessage` so it no longer acks
   after `ws.send`. Instead: attach a server-generated `messageId` to the outgoing
   header, send, then register `_pendingRmqAcks` (messageId →
   `{ rmqMessage, channel, ws, timer }`, timer = `clientAckTimeout`, default 10000,
   new `WebMQServerOptions` field) and return without blocking the `_queues` chain.
   Add `case 'ack'` to the message switch: look up the entry, `channel.ack`, clear
   timer, delete; unknown messageId → log at DEBUG and ignore (may be a late ack
   for an already-requeued message). On socket `close` (and on D2 terminate): for
   every pending entry belonging to that socket, clear timer and
   `channel.nack(rmqMessage, false, true)`. On ack-timeout: same nack+requeue.
   Guard all ack/nack calls in try/catch (channel may be dead; in that case the
   broker will redeliver unacked messages on channel close anyway). Note: if the
   channel/connection drops, amqplib redelivers all unacked messages automatically —
   no extra work needed, just let pending timers be cleaned up on close.
6. Keep the rest of `_handleRmqMessage` as-is (hook pipeline, `ws.OPEN` check →
   throw → existing catch nacks+requeues immediately, which stays correct: if the
   socket is already known-dead, don't wait for a client ack that can never come).
7. Extend `packages/backend/tests/index.test.ts`: ping→pong, ack on publish/listen,
   nack on invalid action payload, heartbeat terminates a non-ponging socket
   (fake timers), second identify with same sessionId evicts the first
   consumer/socket, RMQ message is acked only after client ack arrives (assert via
   queue message count / redelivery), client-ack timeout triggers nack+requeue.
   Follow the existing test setup (real RabbitMQ via
   docker-compose if that is what current tests use — check first; if so, mark
   heartbeat timing tests with generous tolerances).

### Step 5 — Docs & housekeeping

1. Update `README.md` ONLY where behaviour changed: new client options
   (`pingInterval`, `pongTimeout`, `ackTimeout`), new server options
   (`wsPingInterval`, `clientAckTimeout`), Promise-returning
   `publish`/`listen`/`unlisten`, the EventTarget-based connection events (note:
   `EventTarget`, not Node `EventEmitter` as the README currently claims),
   heartbeat semantics, at-least-once delivery in BOTH directions (client ACKs for
   publishes; server holds the RabbitMQ ack until the client confirms receipt —
   messages may be delivered more than once across reconnects and consumers must
   tolerate duplicates), and the caveat that publishes may be duplicated across
   reconnects (no server-side dedup yet).
2. Update the `Features` bullet list and the EventEmitter section to match
   reality. Update the `Project Structure` section to include `packages/protocol`
   (shared wire protocol: bundle format, message types, constructors) with the
   note that it is `private: true` and must be published if the other packages
   ever are. Do not otherwise restructure the README.
3. There is no `AGENTS.md`; do not create one.

## Acceptance criteria

- `npm run build` from a clean state (all workspaces, protocol first) succeeds;
  `npm run build -w webmq-frontend` and `npm run build -w webmq-backend` succeed
  individually.
- After Step 1 (protocol package refactor): ALL pre-existing frontend/backend
  tests pass unchanged — zero behaviour change.
- `npm run test -w webmq-protocol` (or its jest invocation) passes, including the
  golden-vector wire-format test.
- `npm run test -w webmq-frontend` and `npm run test -w webmq-backend` pass,
  including the new tests (start RabbitMQ first: `docker-compose up -d`).
- Manual scenario checklist (describe results in the final report, use
  `examples/basic-chat` or a minimal script):
  1. Kill the network path without closing TCP (e.g. `docker-compose pause` on a
     proxy, or firewall drop): client detects within `pongTimeout` and reconnects.
  2. Publish 3 messages while disconnected → exactly-once delivery after reconnect
     (no losses, no duplicates) for the normal case.
  3. Stay disconnected > `queueTimeout` → after reconnect the client still receives
     new messages on previously subscribed binding keys (re-listen works).
  4. Reconnect while the old socket is still half-open → server has exactly ONE
     consumer for the session (verify via RabbitMQ management UI,
     http://localhost:15672 guest/guest, queue named by sessionId).
  5. Incoming messages keep arriving after ≥2 reconnects (binaryType regression).
  6. Kill the client process/tab abruptly mid-delivery: the in-flight message is
     redelivered after reconnect (RMQ ack was withheld, timeout nacked+requeued).
     Verify no message is lost between broker and client.

## Out of scope (do NOT implement; note as follow-ups in the final report)

- Server-side messageId dedup store (at-most-once publishes).
- Confirm channels for broker-side publish persistence (B4).
- Persistence of the client offline queue in localStorage (survives page reload).
- Reconnect backoff jitter; `navigator.connection`-aware intervals.
- Aligning the rest of the README API (standalone `setup()` exports,
  Express-style hooks) with the source.
