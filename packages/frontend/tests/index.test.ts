import { WebMQClient, setup, publish, listen, unlisten, close, webMQClient } from '../src/index';

// Create stub globals for Node.js environment
if (!(global as any).WebSocket) {
  (global as any).WebSocket = class WebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
  };
}

if (!(global as any).window) {
  (global as any).window = {};
}

// Mock instances
const mockWebSocketInstance = {
  send: jest.fn(),
  close: jest.fn(),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  readyState: 1, // WebSocket.OPEN
};

const mockSessionStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};

// Helper function to establish WebSocket connection in tests

describe('WebMQClient', () => {
  let client: WebMQClient;

  beforeEach(() => {
    // Clear all mocks first
    jest.clearAllMocks();

    // Spy on global WebSocket constructor
    jest.spyOn(global, 'WebSocket').mockImplementation(() => mockWebSocketInstance as any);

    // Spy on window properties
    jest.spyOn(global as any, 'window', 'get').mockReturnValue({
      sessionStorage: mockSessionStorage,
      addEventListener: jest.fn()
    });

    // Reset mock implementations
    mockWebSocketInstance.readyState = (global as any).WebSocket.OPEN;
    mockSessionStorage.getItem.mockReturnValue(null);

    client = new WebMQClient({ url: 'ws://localhost:8080' });
    client.logLevel = 'silent';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('setup', () => {
    it('should save constructor options', () => {
      // arrange
      const preHook = () => Promise.resolve();
      const onIdentifyHook = () => Promise.resolve();
      const onPublishHook = () => Promise.resolve();
      const onListenHook = () => Promise.resolve();
      const onUnlistenHook = () => Promise.resolve();
      const onMessageHook = () => Promise.resolve();

      // act
      const newClient = new WebMQClient({
        url: 'myUrl',
        hooks: {
          pre: [preHook],
          onIdentify: [onIdentifyHook],
          onPublish: [onPublishHook],
          onListen: [onListenHook],
          onUnlisten: [onUnlistenHook],
          onMessage: [onMessageHook],
        },
        ackTimeoutDelay: 123,
        reconnectionDelay: 456,
        maxReconnectionAttempts: 7,
      });

      // assert
      expect((newClient as any)._url).toBe('myUrl');
      expect((newClient as any)._hooks).toStrictEqual({
        pre: [preHook],
        onIdentify: [onIdentifyHook],
        onPublish: [onPublishHook],
        onListen: [onListenHook],
        onUnlisten: [onUnlistenHook],
        onMessage: [onMessageHook],
      });
      expect((newClient as any)._ackTimeoutDelay).toBe(123);
      expect((newClient as any)._reconnectionDelay).toBe(456);
      expect((newClient as any)._maxReconnectionAttempts).toBe(7);
    });
    it('should save setup options', () => {
      // arrange
      const preHook = () => Promise.resolve();
      const onIdentifyHook = () => Promise.resolve();
      const onPublishHook = () => Promise.resolve();
      const onListenHook = () => Promise.resolve();
      const onUnlistenHook = () => Promise.resolve();
      const onMessageHook = () => Promise.resolve();

      // act
      client.setup({
        url: 'myUrl',
        hooks: {
          pre: [preHook],
          onIdentify: [onIdentifyHook],
          onPublish: [onPublishHook],
          onListen: [onListenHook],
          onUnlisten: [onUnlistenHook],
          onMessage: [onMessageHook],
        },
        ackTimeoutDelay: 123,
        reconnectionDelay: 456,
        maxReconnectionAttempts: 7,
      });

      // assert
      expect((client as any)._url).toBe('myUrl');
      expect((client as any)._hooks).toStrictEqual({
        pre: [preHook],
        onIdentify: [onIdentifyHook],
        onPublish: [onPublishHook],
        onListen: [onListenHook],
        onUnlisten: [onUnlistenHook],
        onMessage: [onMessageHook],
      });
      expect((client as any)._ackTimeoutDelay).toBe(123);
      expect((client as any)._reconnectionDelay).toBe(456);
      expect((client as any)._maxReconnectionAttempts).toBe(7);
    });
  });

  async function establishConnection() {
    // Set up "websocket" and event listeners
    const connectionPromise = (client as any)._ensureConnection();
    // Find open and message handlers
    const openHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
      ([name]) => name === 'open'
    )[1];
    const messageHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
      ([name]) => name === 'message'
    )[1];
    // Invoke 'open' handler, this will cause the client to send the identify message
    openHandler?.({});
    // Find the identify message
    const identifySendCall = mockWebSocketInstance.send.mock.calls.at(-1)[0];
    const identifyMessage = JSON.parse(identifySendCall);
    // Invoke message handler, this will resolve the connection promise
    messageHandler?.({
      data: JSON.stringify({ action: 'ack', messageId: identifyMessage.messageId })
    });

    await connectionPromise;

    return messageHandler;  // Return for sending acks to future messages
  }

  describe('connection', () => {
    it('should connect', async () => {
      // act
      await establishConnection();

      // assert
      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('open', expect.any(Function));
      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWebSocketInstance.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('publish', () => {
    it('should send publish message via WebSocket', async () => {
      // arrange
      const messageHandler = await establishConnection();

      // act
      const publishPromise = client.publish('test.key', { data: 'hello' });
      // Wait for next tick to allow publish to send
      await Promise.resolve();

      const publishMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
      messageHandler?.({
        data: JSON.stringify({ action: 'ack', messageId: publishMessage.messageId })
      });

      await publishPromise;

      // assert
      expect(publishMessage.action).toBe('publish');
      expect(publishMessage.routingKey).toBe('test.key');
      expect(publishMessage.payload).toEqual({ data: 'hello' });
      expect(publishMessage.messageId).toBeDefined();
    });

    it('should reject if timeout', async () => {
      // arrange
      client.setup({ ackTimeoutDelay: 10 });
      await establishConnection();

      // act
      const publishPromise = client.publish('test.key', { data: 'hello' });

      // Don't send ack - let it timeout

      // assert
      await expect(publishPromise).rejects.toThrow('Message timeout');
    });

    it('should reject if receives nack', async () => {
      // arrange
      const messageHandler = await establishConnection();

      // act
      const publishPromise = client.publish('test.key', { data: 'hello' });

      // Wait for next tick to allow publish to send
      await Promise.resolve();

      const publishMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
      messageHandler?.({
        data: JSON.stringify({ action: 'nack', messageId: publishMessage.messageId, error: 'nack reason' })
      });

      // assert
      let successfulPublish = false;
      let error: any = null;
      try {
        await publishPromise;
        successfulPublish = true;
      } catch (e: any) {
        error = e;
      }
      expect(successfulPublish).toBe(false);
      expect(error).toStrictEqual(new Error('nack reason'));
    });
  });

  describe('listen', () => {
    it('should listen for new binding key', async () => {
      // arrange
      const messageHandler = await establishConnection();
      const callback = jest.fn();

      // act
      const listenPromise = client.listen('test.key', callback);

      // Wait for next tick to allow listen to send
      await Promise.resolve();

      const listenMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
      messageHandler?.({
        data: JSON.stringify({ action: 'ack', messageId: listenMessage.messageId })
      });

      await listenPromise;

      // assert
      expect(listenMessage).toStrictEqual({
        action: 'listen', bindingKey: 'test.key', messageId: expect.any(String)
      });
      expect((client as any)._messageListeners).toStrictEqual(
        new Map([['test.key', new Set([callback])]])
      );
    });

    it('should not send duplicate listen message for same binding key', async () => {
      // arrange
      const [callback1, callback2] = [jest.fn(), jest.fn()];
      (client as any)._messageListeners.set('test.key', new Set([callback1]))

      // act
      await client.listen('test.key', callback2);  // No need to ack

      // assert
      expect((client as any)._messageListeners).toStrictEqual(
        new Map([['test.key', new Set([callback1, callback2])]])
      );
    });

    it('should reject if listen times out', async () => {
      // arrange
      client.setup({ ackTimeoutDelay: 10 });
      await establishConnection();

      // act
      const listenPromise = client.listen('test.key', jest.fn());

      // Don't send ack - let it timeout

      // assert
      await expect(listenPromise).rejects.toThrow('Message timeout');
    });

    it('should reject if listen receives nack', async () => {
      // arrange
      const messageHandler = await establishConnection();

      // act
      const listenPromise = client.listen('test.key', jest.fn());

      // Wait for next tick to allow publish to send
      await Promise.resolve();

      const listenMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
      messageHandler?.({
        data: JSON.stringify({ action: 'nack', messageId: listenMessage.messageId, error: 'nack reason' })
      });

      // assert
      let successfulListen = false;
      let error: any = null;
      try {
        await listenPromise;
        successfulListen = true;
      } catch (e: any) {
        error = e;
      }
      expect(successfulListen).toBe(false);
      expect(error).toStrictEqual(new Error('nack reason'));
    });
  });

  describe('unlisten', () => {
    it('should send unlisten message when no more listeners', async () => {
      // arrange
      const callback = jest.fn();
      (client as any)._messageListeners.set('test.key', new Set([callback]))
      const messageHandler = await establishConnection();

      // act
      const unlistenPromise = client.unlisten('test.key', callback);

      // Wait for next tick to allow unlisten to send
      await Promise.resolve();

      const unlistenMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
      messageHandler?.({
        data: JSON.stringify({ action: 'ack', messageId: unlistenMessage.messageId })
      });

      await unlistenPromise;

      // assert
      expect(unlistenMessage).toStrictEqual({
        action: 'unlisten', bindingKey: 'test.key', messageId: expect.any(String)
      });
      expect((client as any)._messageListeners).toStrictEqual(new Map());
    });

    it('should not send unlisten if other listeners exist', async () => {
      // arrange
      const [callback1, callback2] = [jest.fn(), jest.fn()];
      (client as any)._messageListeners.set('test.key', new Set([callback1, callback2]));

      // act
      await client.unlisten('test.key', callback2);  // No need to ack

      // assert
      expect((client as any)._messageListeners).toStrictEqual(
        new Map([['test.key', new Set([callback1])]])
      );
    });

    it('should do nothing if callback not found', async () => {
      // arrange 1
      const [callback1, callback2] = [jest.fn(), jest.fn()];

      // act 1
      await client.unlisten('test.key', callback1);  // No need to ack

      // assert 1
      expect((client as any)._messageListeners).toStrictEqual(new Map());

      // arrange 2
      (client as any)._messageListeners.set('test.key', new Set([callback1]));

      // act 2
      await client.unlisten('test.key', callback2);  // No need to ack

      // assert 2
      expect((client as any)._messageListeners).toStrictEqual(
        new Map([['test.key', new Set([callback1])]])
      );
    });
  });

  describe('message handling', () => {
    it('should route incoming messages to registered callbacks', async () => {
      // arrange
      const [callback1, callback2] = [jest.fn(), jest.fn()];
      (client as any)._messageListeners.set('test.key', new Set([callback1, callback2]))
      const messageHandler = await establishConnection();

      // act
      messageHandler?.({
        data: JSON.stringify({ action: 'message', routingKey: 'test.key', payload: 'hello world' })
      });

      // assert
      expect(callback1).toHaveBeenCalledWith('hello world');
      expect(callback2).toHaveBeenCalledWith('hello world');
    });

    it('should use topic wildcards', async () => {
      // arrange
      const [callback1, callback2] = [jest.fn(), jest.fn()];
      (client as any)._messageListeners.set('test.key1', new Set([callback1]));
      (client as any)._messageListeners.set('test.*', new Set([callback2]));
      const messageHandler = await establishConnection();

      // act 1
      messageHandler?.({
        data: JSON.stringify({ action: 'message', routingKey: 'test.key1', payload: 'message1' })
      });

      // assert 1
      expect(callback1).toHaveBeenCalledWith('message1');
      expect(callback2).toHaveBeenCalledWith('message1');

      // act 2
      messageHandler?.({
        data: JSON.stringify({ action: 'message', routingKey: 'test.key2', payload: 'message2' })
      });

      // assert 1
      expect(callback1).not.toHaveBeenCalledWith('message2');
      expect(callback2).toHaveBeenCalledWith('message2');
    });
  });

  describe('Hooks', () => {
    describe('onPublish', () => {
      it('can modify the payload before it is sent', async () => {
        // arrange
        client.setup({
          hooks: {
            onPublish: [async (_, next, msg) => {
              msg.payload.value += 1;
              await next();
            }]
          }
        })
        await establishConnection();

        // act
        client.publish('test.key', { value: 1 });
        // Wait for next tick to allow publish to send
        await Promise.resolve();

        // assert
        const publishMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
        expect(publishMessage.payload.value).toBe(2);  // Hook should have modified payload
      });

      it('can stop the message if it does not call next', async () => {
        // arrange
        client.setup({
          hooks: {
            onPublish: [async (_, next, msg) => {
              if (!msg.payload.abort) {
                await next();
              }
            }]
          }
        })
        await establishConnection();

        // act 1
        client.publish('test.key', { abort: true });
        // Wait for next tick to allow publish to send
        await Promise.resolve();

        // assert 1
        let lastMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
        expect(lastMessage.action).not.toBe('publish');  // publish was aborted

        // act 2
        client.publish('test.key', { abort: false });
        // Wait for next tick to allow publish to send
        await Promise.resolve();

        // assert 2
        lastMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
        expect(lastMessage.action).toBe('publish');
        expect(lastMessage.payload).toEqual({ abort: false });
      });
    });

    describe('onListen hooks', () => {
      it('can modify the payload before it is sent', async () => {
        // arrange
        client.setup({
          hooks: {
            onListen: [async (_, next, msg) => {
              msg.extra = 'extra';
              await next();
            }]
          }
        })
        await establishConnection();

        // act
        const callback = jest.fn();
        client.listen('test.key', callback);
        // Wait for next tick to allow publish to send
        await Promise.resolve();

        // assert
        const listenMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
        expect(listenMessage.extra).toBe('extra');  // Hook should have modified payload
        expect((client as any)._messageListeners).toStrictEqual(
          new Map([['test.key', new Set([callback])]])
        );
      });

      it('can stop listening if it does not call next', async () => {
        client.setup({
          hooks: {
            onListen: [async (_, next, msg) => {
              if (msg.bindingKey !== 'forbidden') {
                await next();
              }
            }]
          }
        })
        await establishConnection();

        // act 1
        client.listen('forbidden', jest.fn());
        // Wait for next tick to allow publish to send
        await Promise.resolve();

        // assert 1
        let lastMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
        expect(lastMessage.action).not.toBe('listen');  // listen was aborted
        expect((client as any)._messageListeners).toStrictEqual(new Map());

        // act 2
        const callback = jest.fn();
        client.listen('test.key', callback);
        // Wait for next tick to allow publish to send
        await Promise.resolve();

        // assert 2
        lastMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
        expect(lastMessage.action).toBe('listen');
        expect(lastMessage.bindingKey).toEqual('test.key');
        expect((client as any)._messageListeners).toStrictEqual(
          new Map([['test.key', new Set([callback])]])
        );
      });
    });

    describe('onUnlisten hooks', () => {
      it('can modify the payload before it is sent', async () => {
        // arrange
        client.setup({
          hooks: {
            onUnlisten: [async (_, next, msg) => {
              msg.extra = 'extra';
              await next();
            }]
          }
        });
        const callback = jest.fn();
        (client as any)._messageListeners.set('test.key', new Set([callback]));
        await establishConnection();

        // act
        client.unlisten('test.key', callback);
        // Wait for next tick to allow publish to send
        await Promise.resolve();

        // assert
        const unlistenMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
        expect(unlistenMessage.extra).toBe('extra');  // Hook should have modified payload
      });

      it('can stop unlistening if it does not call next', async () => {
        client.setup({
          hooks: {
            onUnlisten: [async (_c, _next) => { }]
          }
        })
        const callback = jest.fn();
        (client as any)._messageListeners.set('test.key', new Set([callback]));
        await establishConnection();

        // act
        client.unlisten('test.key', callback);
        // Wait for next tick to allow publish to send
        await Promise.resolve();

        // assert
        let lastMessage = JSON.parse(mockWebSocketInstance.send.mock.calls.at(-1)[0]);
        expect(lastMessage.action).not.toBe('unlisten');  // listen was aborted
        expect((client as any)._messageListeners).toStrictEqual(
          new Map([['test.key', new Set([callback])]])
        );
      });
    });

    describe('onMessage hooks', () => {
      it('can enhance messages', async () => {
        // arrange
        client.setup({
          hooks: {
            onMessage: [async (_c, next, msg) => {
              msg.payload.value += 1;
              await next()
            }]
          }
        });
        const callback = jest.fn();
        (client as any)._messageListeners.set('test.key', new Set([callback]));
        const messageHandler = await establishConnection();

        // act
        messageHandler?.({
          data: JSON.stringify({ action: 'message', routingKey: 'test.key', payload: { value: 1 } })
        });

        // assert
        expect(callback).toHaveBeenCalledWith({ value: 2 });
      });

      it('can block messages if it does not call next', async () => {
        // arrange
        client.setup({
          hooks: {
            onMessage: [async (_c, next, msg) => {
              if (msg.payload.allow) await next();
            }]
          }
        });
        const callback = jest.fn();
        (client as any)._messageListeners.set('test.key', new Set([callback]));
        const messageHandler = await establishConnection();

        // act 1
        messageHandler?.({
          data: JSON.stringify({
            action: 'message', routingKey: 'test.key', payload: { allow: false }
          })
        });

        // assert 2
        expect(callback).not.toHaveBeenCalled();

        // act 1
        messageHandler?.({
          data: JSON.stringify({
            action: 'message', routingKey: 'test.key', payload: { allow: true }
          })
        });

        // assert 2
        expect(callback).toHaveBeenCalledWith({ allow: true });
      });
    });

    it('persists context', async () => {
      // arrange
      client.setup({
        hooks: {
          pre: [async (context, next, msg) => {
            if (!('actionMap' in context)) context.actionMap = new Map<string, number>();
            context.actionMap.set(msg.action, (context.actionMap.get(msg.action) || 0) + 1);
            await next();
          }]
        }
      });

      // act 1
      await establishConnection();

      // assert 1
      expect((client as any)._context.actionMap).toStrictEqual(new Map([['identify', 1]]));

      // act 2
      client.publish('test.key', { data: 'hello' });
      // Wait for next tick to allow publish to send
      await Promise.resolve();

      // assert 2
      expect((client as any)._context.actionMap).toStrictEqual(
        new Map([['identify', 1], ['publish', 1]])
      );

      // act 3
      client.publish('test.key', { data: 'hello' });
      // Wait for next tick to allow publish to send
      await Promise.resolve();

      // assert 2
      expect((client as any)._context.actionMap).toStrictEqual(
        new Map([['identify', 1], ['publish', 2]])
      );
    });
  });

  describe('Connection Management', () => {
    // should create sessionId from sessionStorage if available
    // should generate new sessionId if none exists
    // should work in Node.js environment without sessionStorage
    // should store URL correctly
  });

  describe('Event Handling', () => {
    it('should receive connected event', async () => {
      // arrange
      const callback = jest.fn();
      client.on('connected', callback);

      // act
      await establishConnection();

      // assert
      expect(callback).toHaveBeenCalled();
    });

    it('should receive disconnected event', async () => {
      // arrange
      const callback = jest.fn();
      client.on('disconnected', callback);
      await establishConnection();

      // act
      client.close();

      // Find and trigger the close handler
      const closeHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'close'
      )[1];
      closeHandler?.({});

      // assert
      expect(callback).toHaveBeenCalled();
    });

    it('should receive reconnecting event', async () => {
      // arrange
      const callback = jest.fn();
      client.on('reconnecting', callback);
      await establishConnection();

      // act
      // Find and trigger the close handler (with _shouldReconnect still true)
      const closeHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'close'
      )[1];
      closeHandler?.({});

      // assert
      expect(callback).toHaveBeenCalled();
    });

    it('should emit error event on error', async () => {
      // arrange
      const callback = jest.fn();
      client.on('error', callback);
      await establishConnection();

      // act
      // Find and trigger the error handler to cache the error
      const errorHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'error'
      )[1];
      const mockError = new Event('error');
      errorHandler?.(mockError);

      // Close the connection (sets _shouldReconnect = false)
      client.close();

      // Trigger the close handler (which will emit the cached error)
      const closeHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'close'
      )[1];
      closeHandler?.({});

      // assert
      expect(callback).toHaveBeenCalledWith(mockError);
    });

    it('should only cache the first error', async () => {
      // arrange
      const callback = jest.fn();
      client.on('error', callback);
      await establishConnection();

      // act
      // Find and trigger the error handler multiple times
      const errorHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'error'
      )[1];
      const firstError = { type: 'error', message: 'first error' };
      const secondError = { type: 'error', message: 'second error' };

      errorHandler?.(firstError);
      errorHandler?.(secondError); // This should be ignored

      // Close the connection (sets _shouldReconnect = false)
      client.close();

      // Trigger the close handler (which will emit only the first cached error)
      const closeHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'close'
      )[1];
      closeHandler?.({});

      // assert
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(firstError);
    });
  });

  describe('Reconnection', () => {
    it('should not reconnect if shouldReconnect is false', async () => {
      // arrange
      const disconnectedCallback = jest.fn();
      client.on('disconnected', disconnectedCallback);
      await establishConnection();
      client.close(); // sets _shouldReconnect = false

      // act
      const closeHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'close'
      )[1];
      closeHandler?.({});

      // assert
      expect(disconnectedCallback).toHaveBeenCalled();
      expect((client as any)._isReconnecting).toBe(false);
    });

    it('should set _isReconnecting when close triggered', async () => {
      // arrange
      await establishConnection();

      // act - trigger close to start reconnection (don't await, just check state change)
      const closeHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'close'
      )[1];
      const closePromise = closeHandler?.({});

      // Wait a tick for the async close handler to start
      await Promise.resolve();

      // assert - _isReconnecting should be set to true during reconnection
      expect((client as any)._isReconnecting).toBe(true);
    });

    it('should emit reconnecting event with attempt number', async () => {
      // arrange
      await establishConnection();
      const reconnectingCallback = jest.fn();
      client.on('reconnecting', reconnectingCallback);

      // act - trigger close to start reconnection
      const closeHandler = mockWebSocketInstance.addEventListener.mock.calls.find(
        ([name]) => name === 'close'
      )[1];
      const closePromise = closeHandler?.({});

      // Wait for first reconnection attempt
      await Promise.resolve();

      // assert
      expect(reconnectingCallback).toHaveBeenCalledWith(1);
    });
  });

  describe('beforeunload', () => {
    it('should disable reconnection on page unload', async () => {
      // arrange
      await establishConnection();

      // Get the beforeunload handler
      const windowMock = (global as any).window;
      const beforeunloadHandler = windowMock.addEventListener.mock.calls.find(
        ([name]: [string]) => name === 'beforeunload'
      )[1];

      // act
      beforeunloadHandler?.();

      // assert
      expect((client as any)._shouldReconnect).toBe(false);
      expect(mockWebSocketInstance.close).toHaveBeenCalled();
    });

    it('should set connection promise to rejected on page unload', async () => {
      // arrange
      await establishConnection();

      // Get the beforeunload handler
      const windowMock = (global as any).window;
      const beforeunloadHandler = windowMock.addEventListener.mock.calls.find(
        ([name]: [string]) => name === 'beforeunload'
      )[1];

      // act
      beforeunloadHandler?.();

      // assert - connection promise should be rejected
      await expect((client as any)._connectionPromise).rejects.toThrow('Page unloading');
    });
  });
});
