# React Native

WebMQ works in React Native (including Expo) out of the box — the library self-polyfills `EventTarget`, `CustomEvent`, `TextEncoder`, `TextDecoder` and hooks into `AppState` for reconnect-on-foreground automatically. The [mobile-chat](https://github.com/kbairak/webmq/tree/main/examples/mobile-chat) example shows a complete Expo app interoperating with the web basic-chat on the same exchange.

Usage is identical to [React](react.md):

```jsx
import { useEffect, useState } from 'react';
import { View, Text, TextInput, Button, FlatList } from 'react-native';
import WebMQClient from 'webmq-frontend';

const client = new WebMQClient({
  url: 'ws://localhost:8080',
  sessionId: 'user-session'
});

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    client.connect();
    client.listen('chat.messages', (msg) =>
      setMessages((prev) => [...prev, msg]));
    return () => { client.unlisten('chat.messages'); client.disconnect(); };
  }, []);

  const send = () => {
    client.publish('chat.messages', { text: input, user: 'mobile-user' });
    setInput('');
  };

  return (
    <View>
      <FlatList data={messages} renderItem={({ item }) =>
        <Text><Text style={{fontWeight:'bold'}}>{item.user}:</Text> {item.text}</Text>
      } keyExtractor={(_, i) => i} />
      <TextInput value={input} onChangeText={setInput} placeholder="Type..." />
      <Button title="Send" onPress={send} />
    </View>
  );
}
```

## NetInfo for faster reconnect

The library detects app-foreground via `AppState`, but that doesn't mean the network is back. For network-aware reconnection, wire up `@react-native-community/netinfo` (or `expo-network`) to call `client.forceReconnect()`:

```jsx
import NetInfo from '@react-native-community/netinfo';

useEffect(() => {
  const unsubscribe = NetInfo.addEventListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) {
      client.forceReconnect();
    }
  });
  return () => unsubscribe();
}, []);
```

## Connection-aware UI

```jsx
function ConnectionDot({ client }) {
  const [color, setColor] = useState('orange');
  useEffect(() => {
    if (!client) return;
    const on = (e) => setColor({ connected: 'green', disconnected: 'red', reconnecting: 'orange' }[e.type]);
    client.addEventListener('connected', on);
    client.addEventListener('disconnected', on);
    client.addEventListener('reconnecting', on);
    return () => {
      client.removeEventListener('connected', on);
      client.removeEventListener('disconnected', on);
      client.removeEventListener('reconnecting', on);
    };
  }, [client]);
  return <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color }} />;
}
```

## Expo monorepo setup

When using Expo in a monorepo, configure `metro.config.js` to watch the workspace root:

```javascript
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(__dirname, '../node_modules')
];

module.exports = config;
```
