import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import WebMQClient from 'webmq-frontend';

interface Message {
  id: string;
  text: string;
  user: string;
}

const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Joe'];
const randomName = () => names[Math.floor(Math.random() * names.length)];

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const WS_URL =
  process.env.EXPO_PUBLIC_WS_URL
  ?? (Platform.OS === 'android' ? 'ws://10.0.2.2:8080' : 'ws://localhost:8080');

type Status = 'connected' | 'reconnecting' | 'disconnected';
const STATUS_COLORS: Record<Status, string> = {
  connected: '#4caf50',
  reconnecting: '#ff9800',
  disconnected: '#f44336',
};

export default function App() {
  const username = useMemo(randomName, []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>('disconnected');

  const appendMessage = useCallback((msg: Message) => setMessages((prev) => [...prev, msg]), []);

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
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <View style={[styles.header, { paddingTop: (StatusBar.currentHeight || 24) + 12 }]}>
          <Text style={styles.username}>My name is {username}</Text>
          <View style={[styles.dot, { backgroundColor: STATUS_COLORS[status] }]} />
        </View>
        <FlatList
          style={styles.list}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <Text style={styles.message}>
              <Text style={styles.bold}>{item.user}</Text>: {item.text}
            </Text>
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
  root: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  username: { fontSize: 18, fontWeight: '600' },
  dot: { width: 12, height: 12, borderRadius: 6 },
  list: { flex: 1, paddingHorizontal: 12 },
  message: { marginVertical: 2 },
  bold: { fontWeight: '700' },
  inputRow: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 4, padding: 8 },
});
