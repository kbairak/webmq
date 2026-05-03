import { useState, useCallback, useMemo, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, Button, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import WebMQClient from 'webmq-frontend';
import { SERVER_IP } from './config';

type UUID = string;
interface Message { id: UUID; text: string; user: string; };

const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Ivy', 'Joe'];
const randomName = () => names[Math.floor(Math.random() * names.length)];
const randomUUID = () => `${Date.now()}-${Math.random()}`;

export default function Chat() {
  const username = useMemo(randomName, [])
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('connecting');

  const appendMessage = useCallback((msg: Message) => setMessages(
    (prev) => ([...prev, msg])
  ), []);

  const webMQClient = useMemo(() => new WebMQClient({
    url: `ws://${SERVER_IP}:8080`, sessionId: randomUUID(), logLevel: 'DEBUG'
  }), []);

  useEffect(() => {
    webMQClient.connect();
    webMQClient.on('connect', () => setConnectionStatus('connected'));
    webMQClient.on('disconnect', () => setConnectionStatus('disconnected'));
    webMQClient.on('connect_error', () => setConnectionStatus('disconnected'));
    webMQClient.listen('chat.messages', appendMessage);
    return () => {
      webMQClient.unlisten('chat.messages', appendMessage);
      webMQClient.disconnect();
    };
  }, [webMQClient, appendMessage]);

  const handleSubmit = () => {
    if (!inputText.trim()) { return; }
    webMQClient.publish('chat.messages', {
      id: randomUUID(), text: inputText, user: username
    });
    setInputText('');
  };

  const statusColor = {
    connected: '#4caf50',
    disconnected: '#f44336',
    reconnecting: '#ff9800',
    reconnected: '#4caf50',
    connecting: '#2196f3'
  }[connectionStatus];

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.headerContainer}>
        <Text style={styles.header}>My name is {username}</Text>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
      </View>
      <ScrollView style={styles.messages}>
        {messages.map((msg) => (
          <Text key={msg.id} style={styles.message}>
            <Text style={styles.username}>{msg.user}</Text>: {msg.text}
          </Text>
        ))}
      </ScrollView>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Type a message"
          onSubmitEditing={handleSubmit}
          returnKeyType="send"
        />
        <Button title="Send" onPress={handleSubmit} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 50,
  },
  headerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
  },
  header: {
    fontSize: 20,
    fontWeight: 'bold',
    flex: 1,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  messages: {
    flex: 1,
    padding: 10,
  },
  message: {
    paddingVertical: 5,
  },
  username: {
    fontWeight: 'bold',
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#ccc',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 5,
    padding: 10,
    marginRight: 10,
  },
});
