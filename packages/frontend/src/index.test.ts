import { WebMQClient, setup, publish, listen, unlisten, client } from './index';

// Mock the WebSocket implementation
const mockWebSocketInstance = {
  send: jest.fn().mockResolvedValue(undefined),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  close: jest.fn(),
  readyState: 1,
  url: 'ws://test:8080'
};

jest.mock('./websocket', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => mockWebSocketInstance)
  };
});

describe('WebMQClient', () => {
  let webmqClient: WebMQClient;

  beforeEach(() => {
    webmqClient = new WebMQClient();
    webmqClient.logLevel = 'silent';
    jest.clearAllMocks();
  });

  describe('setup', () => {
    it('should configure WebSocket URL', () => {
      webmqClient.setup('ws://localhost:8080');

      const WebMQClientWebSocket = require('./websocket').default;
      expect(WebMQClientWebSocket).toHaveBeenCalledWith('ws://localhost:8080');
    });

    it('should set up message event listener', () => {
      webmqClient.setup('ws://localhost:8080');

      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  describe('publish', () => {
    it('should throw error if setup not called', async () => {
      await expect(webmqClient.publish('test.key', { data: 'test' }))
        .rejects.toThrow('Call setup() first');
    });

    it('should send publish message via WebSocket', async () => {
      webmqClient.setup('ws://localhost:8080');

      await webmqClient.publish('test.key', { data: 'test' });

      expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
        action: 'publish',
        routingKey: 'test.key',
        payload: { data: 'test' }
      });
    });
  });

  describe('listen', () => {
    it('should throw error if setup not called', async () => {
      const callback = jest.fn();
      await expect(webmqClient.listen('test.key', callback))
        .rejects.toThrow('Call setup() first');
    });

    it('should send listen message for new binding key', async () => {
      webmqClient.setup('ws://localhost:8080');
      const callback = jest.fn();

      await webmqClient.listen('test.key', callback);

      expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
        action: 'listen',
        bindingKey: 'test.key'
      });
    });

    it('should add callback to listeners map', async () => {
      webmqClient.setup('ws://localhost:8080');
      const callback = jest.fn();

      await webmqClient.listen('test.key', callback);

      const listeners = (webmqClient as any).messageListeners;
      expect(listeners.get('test.key')).toBeInstanceOf(Set);
      expect(listeners.get('test.key').has(callback)).toBe(true);
    });

    it('should not send duplicate listen message for same binding key', async () => {
      webmqClient.setup('ws://localhost:8080');
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      await webmqClient.listen('test.key', callback1);
      await webmqClient.listen('test.key', callback2);

      expect(mockWebSocketInstance.send).toHaveBeenCalledTimes(1);

      const listeners = (webmqClient as any).messageListeners;
      const callbackSet = listeners.get('test.key');
      expect(callbackSet).toBeInstanceOf(Set);
      expect(callbackSet.has(callback1)).toBe(true);
      expect(callbackSet.has(callback2)).toBe(true);
      expect(callbackSet.size).toBe(2);
    });
  });

  describe('unlisten', () => {
    it('should throw error if setup not called', async () => {
      const callback = jest.fn();
      await expect(webmqClient.unlisten('test.key', callback))
        .rejects.toThrow('Call setup() first');
    });

    it('should remove callback from listeners', async () => {
      webmqClient.setup('ws://localhost:8080');
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      await webmqClient.listen('test.key', callback1);
      await webmqClient.listen('test.key', callback2);
      await webmqClient.unlisten('test.key', callback1);

      const listeners = (webmqClient as any).messageListeners;
      const callbackSet = listeners.get('test.key');
      expect(callbackSet).toBeInstanceOf(Set);
      expect(callbackSet.has(callback1)).toBe(false);
      expect(callbackSet.has(callback2)).toBe(true);
      expect(callbackSet.size).toBe(1);
    });

    it('should send unlisten message when no more listeners', async () => {
      webmqClient.setup('ws://localhost:8080');
      const callback = jest.fn();

      await webmqClient.listen('test.key', callback);
      mockWebSocketInstance.send.mockClear(); // Clear the listen call

      await webmqClient.unlisten('test.key', callback);

      expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
        action: 'unlisten',
        bindingKey: 'test.key'
      });

      const listeners = (webmqClient as any).messageListeners;
      expect(listeners.has('test.key')).toBe(false);
    });

    it('should do nothing if callback not found', async () => {
      webmqClient.setup('ws://localhost:8080');
      const callback = jest.fn();

      await webmqClient.unlisten('test.key', callback);

      expect(mockWebSocketInstance.send).not.toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    it('should route incoming messages to registered callbacks', () => {
      webmqClient.setup('ws://localhost:8080');
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      // Set up listeners
      webmqClient.listen('test.key', callback1);
      webmqClient.listen('test.key', callback2);

      // Get the message handler that was registered
      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      expect(messageHandlerCall).toBeDefined();
      const messageHandler = messageHandlerCall![1];

      // Simulate incoming message
      const event = {
        data: JSON.stringify({
          action: 'message',
          bindingKeys: ['test.key'],
          payload: { hello: 'world' }
        })
      };

      messageHandler(event);

      expect(callback1).toHaveBeenCalledWith({ hello: 'world' });
      expect(callback2).toHaveBeenCalledWith({ hello: 'world' });
    });

    it('should ignore non-message actions', () => {
      webmqClient.setup('ws://localhost:8080');
      const callback = jest.fn();

      webmqClient.listen('test.key', callback);

      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      const messageHandler = messageHandlerCall![1];

      // Simulate ack message (should be ignored)
      const event = {
        data: JSON.stringify({
          action: 'ack',
          messageId: 'test-123'
        })
      };

      messageHandler(event);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle invalid JSON gracefully', () => {
      webmqClient.setup('ws://localhost:8080');
      const callback = jest.fn();

      webmqClient.listen('test.key', callback);

      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      const messageHandler = messageHandlerCall![1];

      // Simulate invalid JSON
      const event = { data: 'invalid-json{' };

      expect(() => messageHandler(event)).not.toThrow();
      expect(callback).not.toHaveBeenCalled();
    });

    it('should only call callbacks for matching binding keys', () => {
      webmqClient.setup('ws://localhost:8080');
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      webmqClient.listen('test.key1', callback1);
      webmqClient.listen('test.key2', callback2);

      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      const messageHandler = messageHandlerCall![1];

      // Message for key1 only
      const event = {
        data: JSON.stringify({
          action: 'message',
          bindingKeys: ['test.key1'],
          payload: { data: 'for key1' }
        })
      };

      messageHandler(event);

      expect(callback1).toHaveBeenCalledWith({ data: 'for key1' });
      expect(callback2).not.toHaveBeenCalled();
    });

    it('should deliver message to all callbacks when multiple bindingKeys match', () => {
      webmqClient.setup('ws://localhost:8080');
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      webmqClient.listen('user.*', callback1);
      webmqClient.listen('user.#', callback2);
      webmqClient.listen('user.login', callback3);

      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      const messageHandler = messageHandlerCall![1];

      // Message with multiple matching bindingKeys (optimization case)
      const event = {
        data: JSON.stringify({
          action: 'message',
          bindingKeys: ['user.*', 'user.#', 'user.login'],
          payload: { action: 'login' }
        })
      };

      messageHandler(event);

      // All three callbacks should be invoked with the same payload
      expect(callback1).toHaveBeenCalledWith({ action: 'login' });
      expect(callback2).toHaveBeenCalledWith({ action: 'login' });
      expect(callback3).toHaveBeenCalledWith({ action: 'login' });
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Singleton exports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the default client's state
    (client as any).ws = null;
    (client as any).messageListeners.clear();
    client.logLevel = 'silent';
  });

  it('should export bound methods from default client', async () => {
    setup('ws://localhost:8080');

    const WebMQClientWebSocket = require('./websocket').default;
    expect(WebMQClientWebSocket).toHaveBeenCalledWith('ws://localhost:8080');
  });

  it('should allow publishing via singleton', async () => {
    setup('ws://localhost:8080');

    await publish('test.key', { data: 'test' });

    expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
      action: 'publish',
      routingKey: 'test.key',
      payload: { data: 'test' }
    });
  });

  it('should allow listening via singleton', async () => {
    setup('ws://localhost:8080');
    const callback = jest.fn();

    await listen('test.key', callback);

    expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
      action: 'listen',
      bindingKey: 'test.key'
    });
  });

  it('should allow unlistening via singleton', async () => {
    setup('ws://localhost:8080');
    const callback = jest.fn();

    await listen('test.key', callback);
    mockWebSocketInstance.send.mockClear();

    await unlisten('test.key', callback);

    expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
      action: 'unlisten',
      bindingKey: 'test.key'
    });
  });

  it('should export the default client instance', () => {
    expect(client).toBeInstanceOf(WebMQClient);
  });
});