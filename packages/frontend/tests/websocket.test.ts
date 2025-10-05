import WebMQClientWebSocket from '../src/websocket';

// Mock UUID generation for predictable messageIds
let uuidCounter = 1;
jest.mock('uuid', () => ({
  v4: jest.fn(() => `test-uuid-${uuidCounter++}`)
}));

// Mock WebSocket with comprehensive API
const mockWebSocketInstance = {
  send: jest.fn(),
  close: jest.fn(),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  readyState: 1, // WebSocket.OPEN
  protocol: '',
  extensions: '',
  bufferedAmount: 0,
};

global.WebSocket = jest.fn(() => mockWebSocketInstance) as any;
Object.defineProperty(global.WebSocket, 'CONNECTING', { value: 0 });
Object.defineProperty(global.WebSocket, 'OPEN', { value: 1 });
Object.defineProperty(global.WebSocket, 'CLOSING', { value: 2 });
Object.defineProperty(global.WebSocket, 'CLOSED', { value: 3 });

// Mock sessionStorage
const mockSessionStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};

describe('WebMQClientWebSocket', () => {
  let originalWindow: any;
  let originalSessionStorage: any;
  let ws: WebMQClientWebSocket;

  beforeEach(() => {
    jest.useFakeTimers();

    // Reset UUID counter for predictable test behavior
    uuidCounter = 1;

    // Save original values
    originalWindow = (global as any).window;
    originalSessionStorage = (global as any).sessionStorage;

    // Set up clean window mock and sessionStorage global for each test
    Object.defineProperty(global, 'window', {
      value: { sessionStorage: mockSessionStorage },
      writable: true,
      configurable: true
    });

    // Also set sessionStorage as a global for direct access
    Object.defineProperty(global, 'sessionStorage', {
      value: mockSessionStorage,
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();

    // Clean up all mocks after each test
    jest.clearAllMocks();
    (global.WebSocket as any).mockClear();

    // Reset WebSocket mock state
    mockWebSocketInstance.readyState = WebSocket.OPEN;
    mockWebSocketInstance.addEventListener.mockClear();
    mockWebSocketInstance.send.mockClear();
    mockWebSocketInstance.close.mockClear();

    // Reset sessionStorage mock state
    mockSessionStorage.getItem.mockClear();
    mockSessionStorage.setItem.mockClear();

    // Restore original global values to prevent cross-test-suite contamination
    if (originalWindow !== undefined) {
      (global as any).window = originalWindow;
    } else {
      delete (global as any).window;
    }

    if (originalSessionStorage !== undefined) {
      (global as any).sessionStorage = originalSessionStorage;
    } else {
      delete (global as any).sessionStorage;
    }
  });

  describe('Constructor & Session Management', () => {
    it('should create sessionId from sessionStorage if available', () => {
      mockSessionStorage.getItem.mockReturnValue('existing-session-123');

      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      expect(mockSessionStorage.getItem).toHaveBeenCalledWith('webmq_session_id');
      expect(ws.sessionId).toBe('existing-session-123');
      expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
    });

    it('should generate new sessionId if none exists', () => {
      mockSessionStorage.getItem.mockReturnValue(null);

      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      expect(mockSessionStorage.getItem).toHaveBeenCalledWith('webmq_session_id');
      expect(mockSessionStorage.setItem).toHaveBeenCalledWith('webmq_session_id', 'test-uuid-1');
      expect(ws.sessionId).toBe('test-uuid-1');
    });

    it('should work in Node.js environment without sessionStorage', () => {
      delete (global as any).window;
      delete (global as any).sessionStorage;

      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      expect(ws.sessionId).toBe('test-uuid-1');
      expect(mockSessionStorage.getItem).not.toHaveBeenCalled();
      expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
    });

    it('should store URL correctly', () => {
      const url = 'wss://example.com:9999/path';
      const ws = new WebMQClientWebSocket(url);

      expect(ws.url).toBe(url);
    });
  });

  describe('WebSocket Properties & API Compatibility', () => {
    it('should return correct readyState when no connection', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');
      expect(ws.readyState).toBe(WebSocket.CONNECTING);
    });

    it('should proxy WebSocket properties correctly', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      expect(ws.protocol).toBe('');
      expect(ws.extensions).toBe('');
      expect(ws.bufferedAmount).toBe(0);
    });

    it('should handle binaryType correctly', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      expect(ws.binaryType).toBe('blob');

      expect(() => {
        ws.binaryType = 'arraybuffer';
      }).toThrow('WebMQClientWebSocket does not support changing binaryType');
    });
  });

  describe('Event Handling', () => {
    it('should add and remove event listeners correctly', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');
      const openHandler = jest.fn();
      const messageHandler = jest.fn();

      ws.addEventListener('open', openHandler);
      ws.addEventListener('message', messageHandler);

      const listeners = (ws as any)._eventListeners;
      expect(listeners.open.has(openHandler)).toBe(true);
      expect(listeners.message.has(messageHandler)).toBe(true);

      ws.removeEventListener('open', openHandler);
      expect(listeners.open.has(openHandler)).toBe(false);
      expect(listeners.message.has(messageHandler)).toBe(true);
    });

    it('should emit events to registered listeners', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');
      const messageListener = jest.fn();

      ws.addEventListener('message', messageListener);

      // Trigger connection to establish WebSocket handlers
      ws.send({ test: 'data' });

      // Get the WebSocket message handler
      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      expect(messageHandlerCall).toBeDefined();
      const messageHandler = messageHandlerCall![1];

      // Simulate non-ack message
      const event = {
        data: JSON.stringify({
          action: 'message',
          bindingKey: 'test.key',
          payload: { hello: 'world' }
        })
      };

      messageHandler(event);

      expect(messageListener).toHaveBeenCalledWith(event);
    });
  });

  describe('Lazy Connection Pattern', () => {
    it('should not connect until send() is called', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      expect(global.WebSocket).not.toHaveBeenCalled();
      expect((ws as any)._connectionPromise).toBe(null);
    });

    it('should send identify message on connection open', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      // Trigger connection
      ws.send({ test: 'data' });

      // Get the open handler
      const openHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'open'
      );
      expect(openHandlerCall).toBeDefined();
      const openHandler = openHandlerCall![1];

      // Clear any previous calls
      mockWebSocketInstance.send.mockClear();

      // Simulate connection opening (this is initial connection, not reconnection)
      openHandler({});


      // Should have called send twice: identify first, then original message
      expect(mockWebSocketInstance.send).toHaveBeenCalledTimes(2);

      // First call should be the identify message
      const identifyCall = mockWebSocketInstance.send.mock.calls[0][0];
      const identifyMessage = JSON.parse(identifyCall);
      expect(identifyMessage.action).toBe('identify');
      expect(identifyMessage.sessionId).toBe('test-uuid-1'); // sessionId from constructor

      // Second call should be the original pending message
      const originalCall = mockWebSocketInstance.send.mock.calls[1][0];
      const originalMessage = JSON.parse(originalCall);
      expect(originalMessage.test).toBe('data');
      expect(originalMessage.messageId).toBe('test-uuid-2'); // messageId from send call
    });

    it('should establish connection when send() is called', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      ws.send({ test: 'data' });

      expect(global.WebSocket).toHaveBeenCalledWith('ws://test:8080');
      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('open', expect.any(Function));
      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should handle connection state transitions', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      expect((ws as any)._connectionPromise).toBe(null);

      // Trigger connection
      ws.send({ test: 'data' });

      // Simulate connection opening
      mockWebSocketInstance.readyState = WebSocket.OPEN;

      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('should send identify message on reconnection', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      // Initial connection
      ws.send({ test: 'data' });

      // Get handlers
      const openHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'open'
      )![1];
      const closeHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'close'
      )![1];

      // Simulate initial connection and open
      openHandler({});
      mockWebSocketInstance.send.mockClear();

      // Simulate close (triggers reconnection)
      (ws as any)._reconnectAttempts = 0; // Reset for clean test
      closeHandler({});

      // Simulate reconnection open
      (ws as any)._reconnectAttempts = 1; // Simulate this is a reconnection
      openHandler({});

      // Should send identify on reconnection too
      const identifyCall = mockWebSocketInstance.send.mock.calls.find(call => {
        const message = JSON.parse(call[0]);
        return message.action === 'identify';
      });

      expect(identifyCall).toBeDefined();
      const identifyMessage = JSON.parse(identifyCall![0]);
      expect(identifyMessage.action).toBe('identify');
      expect(identifyMessage.sessionId).toBe('test-uuid-1');
    });
  });

  describe('Message Management', () => {
    it('should generate UUID for each message', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      ws.send({ action: 'test', data: 'hello' });

      // Check that message was added to pending messages
      const pendingMessages = (ws as any)._pendingMessages;
      expect(pendingMessages.size).toBe(1);
      expect(pendingMessages.has('test-uuid-2')).toBe(true);

      const pending = pendingMessages.get('test-uuid-2');
      expect(pending.data).toEqual({
        action: 'test',
        data: 'hello',
        messageId: 'test-uuid-2'
      });
    });

    it('should set timeout for pending messages', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      ws.send({ test: 'data' });
      const pending = (ws as any)._pendingMessages.get('test-uuid-2');

      expect(pending.timeout).toBeDefined();
      expect(typeof pending.timeout).toBe('number');
    });

    it('should reject promise on timeout', async () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      const promise = ws.send({ test: 'data' });

      // Fast forward past timeout
      jest.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow('Message timeout');

      // Should clean up pending message
      const pendingMessages = (ws as any)._pendingMessages;
      expect(pendingMessages.size).toBe(0);
    });

  });

  describe('Message Acknowledgment', () => {
    it('should resolve promise on ack message', async () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      // Trigger connection to establish event handlers
      const promise = ws.send({ test: 'data' });

      // Get the message handler that was registered
      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      expect(messageHandlerCall).toBeDefined();
      const messageHandler = messageHandlerCall![1];

      // Simulate ack response
      messageHandler({
        data: JSON.stringify({
          action: 'ack',
          messageId: 'test-uuid-2'
        })
      });

      await expect(promise).resolves.toBeUndefined();

      // Should clean up pending message
      const pendingMessages = (ws as any)._pendingMessages;
      expect(pendingMessages.size).toBe(0);
    });

    it('should reject promise on nack message', async () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      // Trigger connection to establish event handlers
      const promise = ws.send({ test: 'data' });

      // Get the message handler that was registered
      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      expect(messageHandlerCall).toBeDefined();
      const messageHandler = messageHandlerCall![1];

      // Simulate nack response
      messageHandler({
        data: JSON.stringify({
          action: 'nack',
          messageId: 'test-uuid-2',
          error: 'Test error'
        })
      });

      await expect(promise).rejects.toThrow('Test error');

      // Should clean up pending message
      const pendingMessages = (ws as any)._pendingMessages;
      expect(pendingMessages.size).toBe(0);
    });

    it('should handle malformed JSON messages gracefully', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');
      const messageListener = jest.fn();

      ws.addEventListener('message', messageListener);

      // Trigger connection
      ws.send({ test: 'data' });

      // Get message handler
      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      const messageHandler = messageHandlerCall![1];

      // Simulate malformed JSON - should not crash
      const event = { data: 'invalid-json{' };

      expect(() => messageHandler(event)).not.toThrow();

      // Should emit the original event for non-ack messages
      expect(messageListener).toHaveBeenCalledWith(event);
    });
  });

  describe('Connection Lifecycle', () => {
    it('should clean up properly on close', async () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      // Add some pending messages and catch their rejections
      const promise = ws.send({ test: 'data1' });
      expect((ws as any)._pendingMessages.size).toBe(1);

      // Close connection - this will reject pending promises
      ws.close();

      // The promise should be rejected due to connection closure
      await expect(promise).rejects.toThrow('Connection closed');

      expect((ws as any)._shouldReconnect).toBe(false);
      expect((ws as any)._pendingMessages.size).toBe(0);
      expect(mockWebSocketInstance.close).toHaveBeenCalled();
    });

    it('should handle multiple send calls before connection', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      // Multiple sends should queue up as promises
      const promise1 = ws.send({ test: 'data1' });
      const promise2 = ws.send({ test: 'data2' });

      // Should have triggered connection attempt
      expect(global.WebSocket).toHaveBeenCalled();

      // Both should be promises
      expect(promise1).toBeInstanceOf(Promise);
      expect(promise2).toBeInstanceOf(Promise);

      // Clean up promises to avoid unhandled rejections
      promise1.catch(() => { });
      promise2.catch(() => { });
    });

    it('should set correct public configuration properties', () => {
      const ws = new WebMQClientWebSocket('ws://test:8080', 'silent');

      expect(ws.maxReconnectAttempts).toBe(5);
      expect(ws.reconnectDelay).toBe(1000);
      expect(ws.timeoutDelay).toBe(5000);

      // Should be modifiable
      ws.maxReconnectAttempts = 10;
      ws.reconnectDelay = 2000;
      ws.timeoutDelay = 8000;

      expect(ws.maxReconnectAttempts).toBe(10);
      expect(ws.reconnectDelay).toBe(2000);
      expect(ws.timeoutDelay).toBe(8000);
    });
  });
});
