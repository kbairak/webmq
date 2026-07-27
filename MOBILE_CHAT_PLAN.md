# Plan: `examples/mobile-chat` — Expo chat demo

## 1. Goal

Create `examples/mobile-chat`: a minimal Expo (React Native) chat app with the same
functionality as `examples/basic-chat`, plus:

- A status dot in the top-right corner showing WebSocket connection state.
- A web frontend served from the **same codebase** (Expo web / react-native-web),
  so the example works on iOS, Android and web.
- Interoperability with `examples/basic-chat`'s web frontend (same protocol,
  exchange and routing keys).

UI is deliberately minimal: username at top, message list, text input + Send
button at bottom, connection dot at top-right. No navigation, no sidebars.

The directory `examples/mobile-chat/` already exists and is empty.

## 2. Key facts about this repo (already verified)

- Monorepo, npm workspaces: `packages/*`, `examples/*`, `e2e-tests`. Root
  `package.json` has the workspaces field. **All dependency installs run from the
  repo root** (`npm install`), never `npm install` inside an example dir.
- `webmq-frontend` (workspace v1.0.0) resolves to `packages/frontend`, whose
  `package.json` `exports` points to `dist/`. **Packages must be built first**:
  `npm run build` from repo root.
- `WebMQClient` (`packages/frontend/src/index.ts`) extends `EventTarget` and
  dispatches these events: `connected`, `reconnected`, `reconnecting` (with
  `detail.attempt`), `disconnected`. The status dot subscribes to these.
- `examples/basic-chat` contract (must be replicated exactly for interop):
  - Exchange: `chat_app`, backend port `8080`.
  - Routing/binding key: `chat.messages`.
  - Message shape: `{ id: <uuid>, text: string, user: string }` published as JSON.
  - Backend spins up RabbitMQ via `@testcontainers/rabbitmq` (requires Docker
    running; testcontainers' ryuk is already running on this machine).
- CI only builds packages and runs package tests; examples are not in CI.

## 3. React Native / Hermes compatibility risks (must be handled via polyfills)

`webmq-frontend` + `webmq-protocol` were written for browsers. React Native
(Hermes) lacks several globals they use. Handle all of these in a single
`polyfills.ts` imported **first** in the app entry (order matters — polyfills
must run before `webmq-frontend` is imported anywhere):

| Missing/risky global | Used by | Polyfill |
|---|---|---|
| `crypto.getRandomValues` / `crypto.randomUUID` | bundled `uuid` (inside `webmq-frontend` dist), app code | `react-native-get-random-values` (import side effect) |
| `TextEncoder` / `TextDecoder` | `bundleData`/`unbundleData`, `publish` | `text-encoding` package, assigned to `global` only if undefined |
| `CustomEvent` | `WebMQClient._dispatchEvent`, `ReconnectingWebSocket` | Tiny class extending `Event` with a `detail` field |
| `MessageEvent` | `ReconnectingWebSocket` re-dispatch | Tiny class extending `Event`, `Object.assign(this, init)` |
| `CloseEvent` | `ReconnectingWebSocket` re-dispatch | Same pattern (`code`, `reason`, `wasClean`) |
| `Event` / `EventTarget` | everywhere | Present in RN ≥ 0.73 (Expo SDK 50+). Guard with `typeof` checks; if missing, stop and report — do not attempt a full shim |
| `WebSocket` | `ReconnectingWebSocket` | Provided natively by RN. `binaryType = 'arraybuffer'` is supported by RN's WebSocket — **verify at runtime** that incoming messages arrive as `ArrayBuffer` |
| `window` / `document` | `WebMQClient.connect()` | Already guarded with `typeof` checks in the library — no action needed |

Also: `ws://localhost:8080` does not reach the dev machine from Android emulator
(use `ws://10.0.2.2:8080`) or a physical device (use the machine's LAN IP).
Make the URL configurable via `process.env.EXPO_PUBLIC_WS_URL` (Expo inlines
`EXPO_PUBLIC_*` env vars at bundle time) with per-platform fallbacks.

## 4. Files to create

All under `examples/mobile-chat/`. Full contents below — write them verbatim
unless a step later in the plan requires a change.

```
examples/mobile-chat/
├── package.json
├── app.json
├── metro.config.js
├── tsconfig.json
├── eslint.config.js
├── Makefile
├── index.ts          # entry, registers root component
├── polyfills.ts      # RN/Hermes compatibility shims (imported first)
├── App.tsx           # chat UI
└── backend.ts        # identical to examples/basic-chat/backend.ts
```

### 4.1 `package.json`

```json
{
  "name": "webmq-mobile-chat",
  "private": true,
  "type": "module",
  "main": "index.ts",
  "scripts": {
    "start:backend": "tsx backend.ts",
    "start:frontend": "expo start",
    "start": "concurrently \"npm run start:backend\" \"npm run start:frontend\" --names \"backend,expo\" --prefix-colors \"blue,green\"",
    "web": "expo start --web",
    "lint": "eslint . --ext .ts,.tsx"
  },
  "dependencies": {
    "@expo/metro-runtime": "~6.1.1",
    "@testcontainers/rabbitmq": "^11.5.1",
    "expo": "~54.0.0",
    "react": "19.1.0",
    "react-dom": "19.1.0",
    "react-native": "0.81.4",
    "react-native-get-random-values": "~1.11.0",
    "react-native-web": "^0.21.0",
    "text-encoding": "^0.7.0",
    "webmq-backend": "1.0.0",
    "webmq-frontend": "1.0.0"
  },
  "devDependencies": {
    "@types/react": "~19.1.10",
    "@typescript-eslint/eslint-plugin": "^8.56.1",
    "@typescript-eslint/parser": "^8.56.1",
    "concurrently": "^9.2.1",
    "eslint": "^9.39.4",
    "eslint-plugin-react-hooks": "^7.0.1",
    "tsx": "^4.21.0",
    "typescript": "~5.9.2"
  }
}
```

Notes:
- If npm reports unresolvable peer conflicts at install time, align with whatever
  `npx expo install --check` (run from the example dir) suggests and update this
  file. Expo SDK 54 pairs with RN 0.81 / React 19.1.
- `"type": "module"` matches basic-chat; `metro.config.js` must therefore be ESM
  (`export default`) or named `metro.config.cjs` with CJS syntax. Prefer ESM.

### 4.2 `app.json`

```json
{
  "expo": {
    "name": "mobile-chat",
    "slug": "mobile-chat",
    "version": "1.0.0",
    "platforms": ["ios", "android", "web"]
  }
}
```

### 4.3 `metro.config.js`

Standard Expo monorepo config — required because `webmq-frontend` is a symlinked
workspace package resolved from the repo-root `node_modules`:

```js
import { getDefaultConfig } from 'expo/metro-config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

export default config;
```

### 4.4 `tsconfig.json`

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true
  }
}
```

### 4.5 `eslint.config.js`

Identical to `examples/basic-chat/eslint.config.js` (ts parser + react-hooks
rules). Copy it verbatim.

### 4.6 `Makefile`

Identical to `examples/basic-chat/Makefile`:

```make
lint:
	npm run lint
```

### 4.7 `index.ts` (entry)

```ts
import './polyfills';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
```

### 4.8 `polyfills.ts`

```ts
// Must be imported before anything that imports webmq-frontend.
import 'react-native-get-random-values';

declare const global: any;

// TextEncoder/TextDecoder (missing in Hermes)
if (typeof global.TextEncoder === 'undefined' || typeof global.TextDecoder === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const te = require('text-encoding');
  global.TextEncoder = global.TextEncoder ?? te.TextEncoder;
  global.TextDecoder = global.TextDecoder ?? te.TextDecoder;
}

// Event subclasses (missing in Hermes; Event/EventTarget exist in RN >= 0.73)
if (typeof global.CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent extends Event {
    detail: any;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.detail = init.detail ?? null;
    }
  };
}
if (typeof global.MessageEvent === 'undefined') {
  global.MessageEvent = class MessageEvent extends Event {
    constructor(type: string, init: any = {}) {
      super(type, init);
      Object.assign(this, init);
    }
  };
}
if (typeof global.CloseEvent === 'undefined') {
  global.CloseEvent = class CloseEvent extends Event {
    code?: number; reason?: string; wasClean?: boolean;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.code = init.code; this.reason = init.reason; this.wasClean = init.wasClean;
    }
  };
}

export {};
```

### 4.9 `App.tsx`

Same logic as `examples/basic-chat/App.tsx`, RN components instead of DOM, plus
the connection-status dot. Semantics to preserve exactly:

- Random name from the same 10-name list, chosen once per app instance.
- `new WebMQClient({ url, sessionId: <uuid>, logLevel: 'DEBUG' })`, `connect()`,
  `listen('chat.messages', appendMessage)`; cleanup `unlisten` + `disconnect`.
- Publish `{ id, text, user }` to `chat.messages`; ignore empty input; clear
  input after send.

```tsx
import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View, Text, TextInput, Button, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, SafeAreaView,
} from 'react-native';
import WebMQClient from 'webmq-frontend';

interface Message { id: string; text: string; user: string }

const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Joe'];
const randomName = () => names[Math.floor(Math.random() * names.length)];

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const WS_URL =
  process.env.EXPO_PUBLIC_WS_URL ??
  (Platform.OS === 'android' ? 'ws://10.0.2.2:8080' : 'ws://localhost:8080');

type Status = 'connected' | 'reconnecting' | 'disconnected';
const STATUS_COLORS: Record<Status, string> = {
  connected: '#4caf50', reconnecting: '#ff9800', disconnected: '#f44336',
};

export default function App() {
  const username = useMemo(randomName, []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>('disconnected');

  const appendMessage = useCallback(
    (msg: Message) => setMessages((prev) => [...prev, msg]), []
  );

  const webMQClient = useMemo(
    () => new WebMQClient({ url: WS_URL, sessionId: newId(), logLevel: 'DEBUG' }),
    []
  );

  useEffect(() => {
    const onConnected = () => setStatus('connected');
    const onReconnecting = () => setStatus('reconnecting');
    const onDisconnected = () => setStatus('disconnected');
    webMQClient.addEventListener('connected', onConnected);
    webMQClient.addEventListener('reconnected', onConnected);
    webMQClient.addEventListener('reconnecting', onReconnecting);
    webMQClient.addEventListener('disconnected', onDisconnected);
    webMQClient.connect();
    webMQClient.listen('chat.messages', appendMessage);
    return () => {
      webMQClient.removeEventListener('connected', onConnected);
      webMQClient.removeEventListener('reconnected', onConnected);
      webMQClient.removeEventListener('reconnecting', onReconnecting);
      webMQClient.removeEventListener('disconnected', onDisconnected);
      webMQClient.unlisten('chat.messages', appendMessage);
      webMQClient.disconnect();
    };
  }, [webMQClient, appendMessage]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    webMQClient.publish('chat.messages', { id: newId(), text, user: username });
    setDraft('');
  };

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.username}>My name is {username}</Text>
          <View style={[styles.dot, { backgroundColor: STATUS_COLORS[status] }]} />
        </View>
        <FlatList
          style={styles.list}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <Text style={styles.message}><Text style={styles.bold}>{item.user}</Text>: {item.text}</Text>
          )}
        />
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={handleSend}
            placeholder="Message"
          />
          <Button title="Send" onPress={handleSend} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12 },
  username: { fontSize: 18, fontWeight: '600' },
  dot: { width: 12, height: 12, borderRadius: 6 },
  list: { flex: 1, paddingHorizontal: 12 },
  message: { marginVertical: 2 },
  bold: { fontWeight: '700' },
  inputRow: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 4, padding: 8 },
});
```

### 4.10 `backend.ts`

Copy `examples/basic-chat/backend.ts` verbatim (testcontainer RabbitMQ,
`exchange: 'chat_app'`, `port: 8080`).

## 5. Execution steps

### Phase 0 — prerequisites (sequential, main thread)

1. Ensure Docker is running (`docker ps`).
2. Build workspace packages from repo root: `npm run build`.
3. Verify `packages/frontend/dist/index.js` exists and is newer than
   `packages/frontend/src/index.ts`.

### Phase 1 — scaffold (single subagent)

Create all files from §4 verbatim, then from the **repo root** run
`npm install` (workspaces hoist; never install inside the example dir).
If peer-dependency errors occur, resolve by aligning versions with the Expo SDK
(§4.1 notes) and report every version changed.

### Phase 2 — verification (parallel subagents, after Phase 1)

Run these three checks **in parallel**, in separate subagents. They do not
conflict if each uses its own output dir / the backend keeps running.

**Subagent A — backend smoke test**
1. `npm run start:backend` in `examples/mobile-chat` (leave running in background).
2. Wait for `8080` to accept connections (`nc -z localhost 8080` or equivalent).
3. Optionally: run basic-chat's backend-style probe — a tiny Node script using
   `ws` from root `node_modules` that opens `ws://localhost:8080` and expects
   bytes after sending a bundled `identify` message. Keep it simple: port-open
   is sufficient; protocol correctness is the library's tested behavior.
4. Kill the backend when done.

**Subagent B — web bundle + runtime**
1. `npx expo export --platform web --output-dir /tmp/mobile-chat-export-web` in
   the example dir. Success ⇒ Metro resolves all deps (workspace symlink,
   polyfills, react-native-web) for web.
2. `npx expo start --web --port 8091` in background; `curl -s localhost:8091`
   returns HTML; check Metro logs for red-screen errors. Kill afterwards.

**Subagent C — native bundle**
1. `npx expo export --platform ios --output-dir /tmp/mobile-chat-export-ios`
   (and `--platform android` if time permits). Success ⇒ RN-side resolution
   works. Runtime Hermes globals can't be fully validated without a simulator;
   that's covered by the manual checklist (§6).

Also run (any subagent): `npm run lint` in the example dir; fix all errors.

### Phase 3 — interop verification (main thread or single subagent, sequential)

Interoperability requires **one shared backend**: only one backend may run at a
time because both bind port 8080 and each would spawn its own RabbitMQ container
(separate containers = separate message buses = no interop).

1. Start backend only: `npm run start:backend` in `examples/mobile-chat`.
2. Start basic-chat web frontend only: `npm run start:frontend` in
   `examples/basic-chat` (vite, port 5173).
3. Start mobile-chat frontend: `npm run start:frontend` in `examples/mobile-chat`.
4. Verify bidirectional delivery between the vite web UI and the Expo app
   (Expo web tab counts as the "app" if no simulator is available).
5. Shut everything down.

## 6. Manual verification checklist (for the user)

- [ ] `npm start` in `examples/mobile-chat` boots backend + Expo; QR code shown.
- [ ] Expo Go (physical device, same LAN): app opens, shows random name, dot
      turns green. Set `EXPO_PUBLIC_WS_URL=ws://<dev-machine-LAN-IP>:8080`
      before `expo start` — physical devices cannot use localhost/10.0.2.2.
- [ ] Android emulator: works with default `ws://10.0.2.2:8080`.
- [ ] iOS simulator: works with default `ws://localhost:8080`.
- [ ] Dot turns orange/red when backend stops, green again after restart.
- [ ] Messages sent from phone appear in basic-chat web UI and vice versa.

## 7. Pitfalls / do-not-do list

- **Do not** run `npm install` inside `examples/mobile-chat` — installs happen
  at repo root (npm workspaces).
- **Do not** modify `packages/frontend` or `packages/protocol` to fix RN
  issues — all compatibility handling lives in `polyfills.ts`.
- **Do not** import `webmq-frontend` before `polyfills.ts` (import order in
  `index.ts` is load-bearing: polyfills first).
- **Do not** run two backends at once (port 8080 conflict; also breaks interop
  since each backend gets its own RabbitMQ container).
- **Do not** change the exchange (`chat_app`), routing key (`chat.messages`) or
  message shape — interop with basic-chat depends on them.
- If messages never arrive on-device but do on web: suspect RN WebSocket binary
  delivery (`binaryType='arraybuffer'`). Investigate and report before changing
  library code.
- `text-encoding` prints a deprecation warning on install; that's acceptable.

## 8. Definition of done

1. All files from §4 exist in `examples/mobile-chat`.
2. `npm run lint` passes in the example.
3. `npx expo export` succeeds for web and ios platforms.
4. Backend starts, binds 8080, and the interop scenario (§ Phase 3) delivers
   messages both ways.
5. No changes to `packages/*` or `examples/basic-chat`.
6. This plan file (`MOBILE_CHAT_PLAN.md`) remains at repo root; delete only if
   the user asks.
