import { WebMQClient, setup, publish, listen, unlisten, webMQClient } from './index';

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
    (webMQClient as any).ws = null;
    (webMQClient as any).messageListeners.clear();
    webMQClient.logLevel = 'silent';
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
    expect(webMQClient).toBeInstanceOf(WebMQClient);
  });
});

describe('Hooks', () => {
  let webmqClient: WebMQClient;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('onPublish hooks', () => {
    it('should run pre and onPublish hooks before publishing', async () => {
      const preHook = jest.fn(async (context, message, next) => {
        message.payload.addedByPre = true;
        await next();
      });
      const onPublishHook = jest.fn(async (context, message, next) => {
        message.payload.addedByOnPublish = true;
        await next();
      });

      webmqClient = new WebMQClient('', {
        pre: [preHook],
        onPublish: [onPublishHook]
      });
      webmqClient.logLevel = 'silent';
      webmqClient.setup('ws://localhost:8080');

      await webmqClient.publish('test.key', { original: 'data' });

      expect(preHook).toHaveBeenCalled();
      expect(onPublishHook).toHaveBeenCalled();
      expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
        action: 'publish',
        routingKey: 'test.key',
        payload: { original: 'data', addedByPre: true, addedByOnPublish: true }
      });
    });

    it('should abort publish if hook throws error', async () => {
      const errorHook = jest.fn(async () => {
        throw new Error('Hook rejected');
      });

      webmqClient = new WebMQClient('', { onPublish: [errorHook] });
      webmqClient.logLevel = 'silent';
      webmqClient.setup('ws://localhost:8080');

      await expect(webmqClient.publish('test.key', { data: 'test' })).rejects.toThrow('Hook rejected');
      expect(mockWebSocketInstance.send).not.toHaveBeenCalled();
    });
  });

  describe('onListen hooks', () => {
    it('should run pre and onListen hooks before listening', async () => {
      const preHook = jest.fn(async (context, message, next) => {
        context.modified = true;
        await next();
      });
      const onListenHook = jest.fn(async (context, message, next) => {
        message.bindingKey = 'modified.' + message.bindingKey;
        await next();
      });

      webmqClient = new WebMQClient('', {
        pre: [preHook],
        onListen: [onListenHook]
      });
      webmqClient.logLevel = 'silent';
      webmqClient.setup('ws://localhost:8080');

      const callback = jest.fn();
      await webmqClient.listen('test.key', callback);

      expect(preHook).toHaveBeenCalled();
      expect(onListenHook).toHaveBeenCalled();
      expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
        action: 'listen',
        bindingKey: 'modified.test.key'
      });
    });
  });

  describe('onUnlisten hooks', () => {
    it('should run pre and onUnlisten hooks before unlistening', async () => {
      const onUnlistenHook = jest.fn(async (context, message, next) => {
        context.unlistenCalled = true;
        await next();
      });

      webmqClient = new WebMQClient('', { onUnlisten: [onUnlistenHook] });
      webmqClient.logLevel = 'silent';
      webmqClient.setup('ws://localhost:8080');

      const callback = jest.fn();
      await webmqClient.listen('test.key', callback);
      mockWebSocketInstance.send.mockClear();

      await webmqClient.unlisten('test.key', callback);

      expect(onUnlistenHook).toHaveBeenCalled();
      expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
        action: 'unlisten',
        bindingKey: 'test.key'
      });
    });
  });

  describe('onMessage hooks', () => {
    it('should run pre and onMessage hooks before delivering to callbacks', async () => {
      const preHook = jest.fn(async (context, message, next) => {
        if (message.action === 'message' && message.payload) {
          message.payload.processedByPre = true;
        }
        await next();
      });
      const onMessageHook = jest.fn(async (context, message, next) => {
        message.payload.decrypted = true;
        await next();
      });

      webmqClient = new WebMQClient('', {
        pre: [preHook],
        onMessage: [onMessageHook]
      });
      webmqClient.logLevel = 'silent';
      webmqClient.setup('ws://localhost:8080');

      const callback = jest.fn();
      await webmqClient.listen('test.key', callback);

      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      const messageHandler = messageHandlerCall![1];

      const event = {
        data: JSON.stringify({
          action: 'message',
          bindingKeys: ['test.key'],
          payload: { encrypted: 'data' }
        })
      };

      messageHandler(event);

      // Wait for async hooks to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(preHook).toHaveBeenCalled();
      expect(onMessageHook).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith({
        encrypted: 'data',
        processedByPre: true,
        decrypted: true
      });
    });

    it('should not deliver message if hook throws error', async () => {
      const errorHook = jest.fn(async () => {
        throw new Error('Message rejected by hook');
      });

      webmqClient = new WebMQClient('', { onMessage: [errorHook] });
      webmqClient.logLevel = 'silent';
      webmqClient.setup('ws://localhost:8080');

      const callback = jest.fn();
      await webmqClient.listen('test.key', callback);

      const messageHandlerCall = mockWebSocketInstance.addEventListener.mock.calls.find(
        call => call[0] === 'message'
      );
      const messageHandler = messageHandlerCall![1];

      const event = {
        data: JSON.stringify({
          action: 'message',
          bindingKeys: ['test.key'],
          payload: { data: 'test' }
        })
      };

      messageHandler(event);

      // Wait for async hooks to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(errorHook).toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Context persistence', () => {
    it('should persist context across different hook calls', async () => {
      let contextId: string | undefined;

      const hook1 = jest.fn(async (context, message, next) => {
        if (!context.id) {
          context.id = 'test-session-' + Date.now();
        }
        contextId = context.id;
        await next();
      });

      const hook2 = jest.fn(async (context, message, next) => {
        expect(context.id).toBe(contextId);
        await next();
      });

      webmqClient = new WebMQClient('', {
        pre: [hook1, hook2]
      });
      webmqClient.logLevel = 'silent';
      webmqClient.setup('ws://localhost:8080');

      await webmqClient.publish('test.key1', { data: '1' });
      await webmqClient.publish('test.key2', { data: '2' });

      expect(hook1).toHaveBeenCalledTimes(2);
      expect(hook2).toHaveBeenCalledTimes(2);
      // Both calls should see the same context.id
    });
  });

  describe('Hooks via setup()', () => {
    it('should accept hooks via setup() options', async () => {
      const hook = jest.fn(async (context, message, next) => {
        message.payload.modified = true;
        await next();
      });

      webmqClient = new WebMQClient();
      webmqClient.logLevel = 'silent';
      webmqClient.setup('ws://localhost:8080', { onPublish: [hook] });

      await webmqClient.publish('test.key', { original: 'data' });

      expect(hook).toHaveBeenCalled();
      expect(mockWebSocketInstance.send).toHaveBeenCalledWith({
        action: 'publish',
        routingKey: 'test.key',
        payload: { original: 'data', modified: true }
      });
    });
  });
});
