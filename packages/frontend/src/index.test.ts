import { WebMQClient, client } from './index';

// Disable all logging during tests
client.setLogLevel('silent');

// Mock WebSocket
const mockSend = jest.fn();
const mockClose = jest.fn();
let mockEventListeners: { [key: string]: Function[] } = {};

// Helper function to trigger event listeners
const triggerEvent = (event: string, data?: any) => {
  if (mockEventListeners[event]) {
    mockEventListeners[event].forEach((callback) => {
      if (event === 'message') {
        callback({ data });
      } else {
        callback(data);
      }
    });
  }
};

const MockWebSocket = jest.fn().mockImplementation((url) => {
  mockEventListeners = {}; // Reset for each WebSocket instance

  const wsInstance = {
    url,
    send: mockSend,
    close: mockClose,
    addEventListener: jest.fn((event: string, callback: Function) => {
      if (!mockEventListeners[event]) {
        mockEventListeners[event] = [];
      }
      mockEventListeners[event].push(callback);
    }),
    removeEventListener: jest.fn((event: string, callback: Function) => {
      if (mockEventListeners[event]) {
        mockEventListeners[event] = mockEventListeners[event].filter(cb => cb !== callback);
      }
    }),
  };
  return wsInstance;
});

global.WebSocket = MockWebSocket as any;

describe('WebMQClient (Singleton)', () => {
  beforeEach(() => {
    // Reset mocks and server state for each test
    mockSend.mockClear();
    mockClose.mockClear();
    // We need a fresh instance of the default client for each test, which is tricky.
    // This highlights a downside of testing singletons.
    // For this test, we'll assume the module is re-loaded or we test the class directly.
  });

  describe('WebMQClient Class', () => {
    let client: WebMQClient;

    beforeEach(() => {
      client = new WebMQClient();
      client.setup('ws://localhost:8080');
    });

    it('should connect and send a listen message on first listen', async () => {
      const promise = client.listen('test.key', () => { });
      // Give some time for the WebSocket to be created and event listeners attached
      await new Promise(resolve => setTimeout(resolve, 0));
      // Simulate server connection
      triggerEvent('open');
      await promise;

      expect(MockWebSocket).toHaveBeenCalledWith('ws://localhost:8080');
      expect(mockSend).toHaveBeenCalledWith(JSON.stringify({ action: 'listen', bindingKey: 'test.key' }));
    });

    it('should only send one listen message for multiple listeners on the same key', async () => {
      const promise = client.listen('test.key', () => { });
      triggerEvent('open');
      await promise;

      await client.listen('test.key', () => { });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch messages to the correct callback', async () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      const promise = client.listen('test.key', callback1);
      triggerEvent('open');
      await promise;
      await client.listen('another.key', callback2);

      const message = { type: 'message', bindingKey: 'test.key', payload: { data: 'hello' } };
      triggerEvent('message', JSON.stringify(message));

      expect(callback1).toHaveBeenCalledWith({ data: 'hello' });
      expect(callback2).not.toHaveBeenCalled();
    });

    it('should send unlisten message when the last callback is removed', async () => {
      const callback = () => { };
      const promise = client.listen('test.key', callback);
      await new Promise(resolve => setTimeout(resolve, 0));
      triggerEvent('open');
      await promise;

      // Now unlisten
      await client.unlisten('test.key', callback);

      expect(mockSend).toHaveBeenCalledWith(JSON.stringify({ action: 'unlisten', bindingKey: 'test.key' }));
    });

    it('should NOT send unlisten message if other callbacks still exist', async () => {
      const callback1 = () => { };
      const callback2 = () => { };
      const promise = client.listen('test.key', callback1);
      triggerEvent('open');
      await promise;
      await client.listen('test.key', callback2);

      // Clear mock from the initial listen call
      mockSend.mockClear();

      await client.unlisten('test.key', callback1);

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should send a message', async () => {
      const promise = client.publish('test.route', { data: 123 });
      triggerEvent('open');

      // Acknowledge the message
      const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
      triggerEvent('message', JSON.stringify({
        type: 'ack',
        messageId: sentMessage.messageId,
        status: 'success'
      }));

      await promise;

      expect(sentMessage).toMatchObject({
        action: 'publish',
        routingKey: 'test.route',
        payload: { data: 123 }
      });
      expect(sentMessage.messageId).toBeDefined();
    });

    describe('disconnect', () => {
      it('should disconnect when no listeners exist', () => {
        const promise = client.connect();
        triggerEvent('open');

        client.disconnect();

        expect(mockClose).toHaveBeenCalled();
      });

      it('should ignore disconnect by default when listeners exist', async () => {
        const callback = () => { };
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        client.disconnect(); // Default behavior: ignore

        expect(mockClose).not.toHaveBeenCalled();
      });

      it('should ignore disconnect explicitly when listeners exist', async () => {
        const callback = () => { };
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        client.disconnect({ onActiveListeners: 'ignore' });

        expect(mockClose).not.toHaveBeenCalled();
      });

      it('should throw error when listeners exist and onActiveListeners is "throw"', async () => {
        const callback = () => { };
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        expect(() => {
          client.disconnect({ onActiveListeners: 'throw' });
        }).toThrow('Cannot disconnect: 1 active listeners');
      });

      it('should clear listeners and disconnect when onActiveListeners is "clear"', async () => {
        const callback = () => { };
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        client.disconnect({ onActiveListeners: 'clear' });

        expect(mockClose).toHaveBeenCalled();
        // Verify listeners were cleared by checking internal state
        expect(client._getListenerSize()).toBe(0);
      });

      it('should throw error for invalid onActiveListeners option', () => {
        expect(() => {
          client.disconnect({ onActiveListeners: 'invalid' as any });
        }).toThrow('Invalid onActiveListeners option: invalid');
      });

      it('should reset connection state after disconnect', () => {
        const promise = client.connect();
        triggerEvent('open');

        client.disconnect();

        expect(client._getWebSocket()).toBe(null);
        expect(client._getConnectionState().isConnected).toBe(false);
      });
    });

    describe('automatic reconnection', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('should attempt reconnection when connection drops and listeners exist', async () => {
        const callback = jest.fn();
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        // Clear previous mock calls
        MockWebSocket.mockClear();

        // Simulate connection drop
        triggerEvent('close');

        // Fast-forward timer to trigger reconnection
        jest.advanceTimersByTime(1000);

        expect(MockWebSocket).toHaveBeenCalledTimes(1);
      });

      it('should NOT attempt reconnection when no listeners exist', async () => {
        const promise = client.connect();
        triggerEvent('open');
        await promise;

        // Clear previous mock calls
        MockWebSocket.mockClear();

        // Simulate connection drop
        triggerEvent('close');

        // Fast-forward timer
        jest.advanceTimersByTime(1000);

        expect(MockWebSocket).not.toHaveBeenCalled();
      });

      it('should stop reconnecting after maxReconnectAttempts', async () => {
        client.setup('ws://localhost:8080', { maxReconnectAttempts: 2 });
        const callback = jest.fn();
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        // Clear previous mock calls
        MockWebSocket.mockClear();

        // Simulate multiple connection drops
        for (let i = 0; i < 3; i++) {
          triggerEvent('close');
          jest.advanceTimersByTime(1000);

          // Connection fails immediately
          if (i < 2) {
            triggerEvent('error', new Error('Connection failed'));
            triggerEvent('close');
          }
        }

        // Should have attempted exactly 2 reconnections
        expect(MockWebSocket).toHaveBeenCalledTimes(2);
      });

      it('should reset reconnection attempts on successful connection', async () => {
        client.setup('ws://localhost:8080', { maxReconnectAttempts: 3 });
        const callback = jest.fn();
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        // Clear previous mock calls
        MockWebSocket.mockClear();

        // First reconnection cycle - one failed attempt, then success
        triggerEvent('close');
        jest.advanceTimersByTime(1000); // First attempt
        triggerEvent('error', new Error('Connection failed'));
        triggerEvent('close');
        jest.advanceTimersByTime(2000); // Second attempt
        triggerEvent('open'); // Successful reconnection (resets attempts)

        // Clear mock calls
        MockWebSocket.mockClear();

        // Second reconnection cycle - should get full attempts again (attempts were reset)
        triggerEvent('close');
        jest.advanceTimersByTime(1000); // First attempt (delay should be 1s again, not 4s)
        triggerEvent('error', new Error('Connection failed'));
        triggerEvent('close');
        jest.advanceTimersByTime(2000); // Second attempt (delay should be 2s)

        // Should have attempted 2 times with reset delays (1s, then 2s)
        expect(MockWebSocket).toHaveBeenCalledTimes(2);
      });

      it('should clear reconnection timeout on manual disconnect', async () => {
        const callback = jest.fn();
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        // Simulate connection drop
        triggerEvent('close');

        // Manually disconnect before timeout
        client.disconnect({ onActiveListeners: 'clear' });

        // Clear previous mock calls
        MockWebSocket.mockClear();

        // Fast-forward timer
        jest.advanceTimersByTime(1000);

        // Should not have attempted reconnection
        expect(MockWebSocket).not.toHaveBeenCalled();
      });

      it('should use exponential backoff for reconnection delays', async () => {
        const callback = jest.fn();
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        // Clear previous mock calls
        MockWebSocket.mockClear();

        // First reconnection - should use 1000ms delay
        triggerEvent('close');
        jest.advanceTimersByTime(999); // Just before 1 second
        expect(MockWebSocket).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1); // At 1 second
        expect(MockWebSocket).toHaveBeenCalledTimes(1);

        // Simulate connection failure and second reconnection - should use 2000ms delay
        triggerEvent('error', new Error('Connection failed'));
        triggerEvent('close');
        MockWebSocket.mockClear();

        jest.advanceTimersByTime(1999); // Just before 2 seconds
        expect(MockWebSocket).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1); // At 2 seconds
        expect(MockWebSocket).toHaveBeenCalledTimes(1);

        // Simulate connection failure and third reconnection - should use 4000ms delay
        triggerEvent('error', new Error('Connection failed'));
        triggerEvent('close');
        MockWebSocket.mockClear();

        jest.advanceTimersByTime(3999); // Just before 4 seconds
        expect(MockWebSocket).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1); // At 4 seconds
        expect(MockWebSocket).toHaveBeenCalledTimes(1);
      });

      it('should cap exponential backoff at 30 seconds', async () => {
        client.setup('ws://localhost:8080', { maxReconnectAttempts: 10 });
        const callback = jest.fn();
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        // Clear previous mock calls
        MockWebSocket.mockClear();

        // Simulate multiple failures to reach the cap
        // Delays: 1s, 2s, 4s, 8s, 16s, 30s (capped)
        const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000];

        for (let i = 0; i < expectedDelays.length; i++) {
          triggerEvent('close');

          const delay = expectedDelays[i];
          jest.advanceTimersByTime(delay - 1); // Just before the delay
          expect(MockWebSocket).toHaveBeenCalledTimes(i); // No new calls yet

          jest.advanceTimersByTime(1); // At the exact delay
          expect(MockWebSocket).toHaveBeenCalledTimes(i + 1); // Should have been called

          // Simulate connection failure (except for the last iteration to avoid extra calls)
          if (i < expectedDelays.length - 1) {
            triggerEvent('error', new Error('Connection failed'));
          }
        }

        // Verify that any subsequent attempts also use 30s delay (the cap)
        triggerEvent('error', new Error('Connection failed'));
        triggerEvent('close');
        MockWebSocket.mockClear();

        jest.advanceTimersByTime(29999); // Just before 30 seconds
        expect(MockWebSocket).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1); // At 30 seconds
        expect(MockWebSocket).toHaveBeenCalledTimes(1);
      });
    });

    describe('connection state events', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('should emit connect event on initial connection', async () => {
        const connectSpy = jest.fn();
        client.on('connect', connectSpy);

        const promise = client.connect();
        triggerEvent('open');
        await promise;

        expect(connectSpy).toHaveBeenCalledTimes(1);
      });

      it('should emit disconnect event when connection is lost', async () => {
        const disconnectSpy = jest.fn();
        client.on('disconnect', disconnectSpy);

        const promise = client.connect();
        triggerEvent('open');
        await promise;

        triggerEvent('close');

        expect(disconnectSpy).toHaveBeenCalledTimes(1);
      });

      it('should emit reconnect event on automatic reconnection', async () => {
        const reconnectSpy = jest.fn();
        const connectSpy = jest.fn();
        client.on('reconnect', reconnectSpy);
        client.on('connect', connectSpy);

        // Set up a listener to enable auto-reconnection
        const callback = jest.fn();
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        // Clear spy calls from initial connection
        connectSpy.mockClear();
        reconnectSpy.mockClear();

        // Simulate disconnection and reconnection
        triggerEvent('close');
        jest.advanceTimersByTime(1000);
        triggerEvent('open');

        expect(connectSpy).not.toHaveBeenCalled(); // Should not emit connect
        expect(reconnectSpy).toHaveBeenCalledTimes(1); // Should emit reconnect
      });

      it('should distinguish between initial connection and reconnection', async () => {
        const connectSpy = jest.fn();
        const reconnectSpy = jest.fn();
        client.on('connect', connectSpy);
        client.on('reconnect', reconnectSpy);

        // Use direct connect() call instead of listen() to match working test pattern
        const promise = client.connect();
        triggerEvent('open');
        await promise;

        // Now set up a listener to enable auto-reconnection
        const callback = jest.fn();
        await client.listen('test.key', callback);

        expect(connectSpy).toHaveBeenCalledTimes(1);
        expect(reconnectSpy).not.toHaveBeenCalled();

        // Clear spies
        connectSpy.mockClear();
        reconnectSpy.mockClear();

        // Simulate disconnection and reconnection
        triggerEvent('close');
        jest.advanceTimersByTime(1000);
        triggerEvent('open');

        expect(connectSpy).not.toHaveBeenCalled();
        expect(reconnectSpy).toHaveBeenCalledTimes(1);
      });

      it('should allow removing event listeners', async () => {
        const connectSpy = jest.fn();
        client.on('connect', connectSpy);
        client.off('connect', connectSpy);

        const promise = client.connect();
        triggerEvent('open');
        await promise;

        expect(connectSpy).not.toHaveBeenCalled();
      });

      it('should support multiple listeners for the same event', async () => {
        const connectSpy1 = jest.fn();
        const connectSpy2 = jest.fn();
        client.on('connect', connectSpy1);
        client.on('connect', connectSpy2);

        const promise = client.connect();
        triggerEvent('open');
        await promise;

        expect(connectSpy1).toHaveBeenCalledTimes(1);
        expect(connectSpy2).toHaveBeenCalledTimes(1);
      });
    });

    describe('message queuing', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('should queue messages when disconnected and publish them on reconnection', async () => {
        // Start disconnected
        expect(client.getQueueSize()).toBe(0);

        // Send messages while disconnected - they should be queued
        const sendPromise1 = client.publish('test.route1', { data: 1 });
        const sendPromise2 = client.publish('test.route2', { data: 2 });

        expect(client.getQueueSize()).toBe(2);

        // Now connect - should flush the queue
        triggerEvent('open');

        // Acknowledge the messages
        const message1 = JSON.parse(mockSend.mock.calls[0][0]);
        const message2 = JSON.parse(mockSend.mock.calls[1][0]);

        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message1.messageId,
          status: 'success'
        }));
        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message2.messageId,
          status: 'success'
        }));

        await sendPromise1;
        await sendPromise2;

        expect(client.getQueueSize()).toBe(0);
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(message1).toMatchObject({
          action: 'publish',
          routingKey: 'test.route1',
          payload: { data: 1 }
        });
        expect(message2).toMatchObject({
          action: 'publish',
          routingKey: 'test.route2',
          payload: { data: 2 }
        });
      });

      it('should publish messages immediately when connected', async () => {
        // Connect first
        const promise = client.connect();
        triggerEvent('open');
        await promise;

        mockSend.mockClear();

        // Send message while connected - should go directly
        const sendPromise = client.publish('test.route', { data: 123 });

        // Acknowledge the message
        const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: sentMessage.messageId,
          status: 'success'
        }));

        await sendPromise;

        expect(client.getQueueSize()).toBe(0);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(sentMessage).toMatchObject({
          action: 'publish',
          routingKey: 'test.route',
          payload: { data: 123 }
        });
      });

      it('should respect maxQueueSize and drop oldest messages', async () => {
        client.setup('ws://localhost:8080', { maxQueueSize: 2 });

        // Send 3 messages while disconnected
        const sendPromise1 = client.publish('test.route1', { data: 1 });
        const sendPromise2 = client.publish('test.route2', { data: 2 });
        const sendPromise3 = client.publish('test.route3', { data: 3 }); // Should drop first message

        expect(client.getQueueSize()).toBe(2);

        // First message should be rejected immediately
        await expect(sendPromise1).rejects.toThrow('Message dropped: queue full');

        // Connect and verify only last 2 messages are sent
        triggerEvent('open');

        const message2 = JSON.parse(mockSend.mock.calls[0][0]);
        const message3 = JSON.parse(mockSend.mock.calls[1][0]);

        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message2.messageId,
          status: 'success'
        }));
        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message3.messageId,
          status: 'success'
        }));

        await Promise.all([sendPromise2, sendPromise3]);

        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(message2).toMatchObject({
          action: 'publish',
          routingKey: 'test.route2',
          payload: { data: 2 }
        });
        expect(message3).toMatchObject({
          action: 'publish',
          routingKey: 'test.route3',
          payload: { data: 3 }
        });
      });

      it('should clear queue manually', async () => {
        // Queue some messages
        const sendPromise1 = client.publish('test.route1', { data: 1 });
        const sendPromise2 = client.publish('test.route2', { data: 2 });

        expect(client.getQueueSize()).toBe(2);

        // Clear queue - should reject promises
        client.clearQueue();
        expect(client.getQueueSize()).toBe(0);

        // Messages should be rejected
        await expect(sendPromise1).rejects.toThrow('Message cleared from queue');
        await expect(sendPromise2).rejects.toThrow('Message cleared from queue');

        // Connect - no messages should be sent
        triggerEvent('open');

        expect(mockSend).not.toHaveBeenCalled();
      });

      it('should flush queue on automatic reconnection', async () => {
        // This test is moved to message acknowledgments section for better timer control
        expect(true).toBe(true);
      });
    });

    describe('message acknowledgments', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('should resolve promise when server sends ack', async () => {
        // Connect first
        const promise = client.connect();
        triggerEvent('open');
        await promise;

        // Send message and wait for response
        const sendPromise = client.publish('test.route', { data: 123 });

        // Simulate server acknowledgment
        const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: sentMessage.messageId,
          status: 'success'
        }));

        // Promise should resolve
        await expect(sendPromise).resolves.toBeUndefined();
      });

      it('should reject promise when server sends nack', async () => {
        // Connect first
        const promise = client.connect();
        triggerEvent('open');
        await promise;

        // Send message
        const sendPromise = client.publish('test.route', { data: 123 });

        // Simulate server rejection
        const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
        triggerEvent('message', JSON.stringify({
          type: 'nack',
          messageId: sentMessage.messageId,
          error: 'Validation failed'
        }));

        // Promise should reject
        await expect(sendPromise).rejects.toThrow('Validation failed');
      });

      it('should reject promise on timeout', async () => {
        client.setup('ws://localhost:8080', { messageTimeout: 1000 });

        // Connect first
        const promise = client.connect();
        triggerEvent('open');
        await promise;

        // Send message but don't respond
        const sendPromise = client.publish('test.route', { data: 123 });

        // Advance time past timeout
        jest.advanceTimersByTime(1001);

        // Promise should reject with timeout error
        await expect(sendPromise).rejects.toThrow('Message timeout after 1000ms');
      });

      it('should publish messages with unique messageId', async () => {
        // Connect first
        const promise = client.connect();
        triggerEvent('open');
        await promise;

        mockSend.mockClear();

        // Send two messages
        const sendPromise1 = client.publish('test.route1', { data: 1 });
        const sendPromise2 = client.publish('test.route2', { data: 2 });

        expect(mockSend).toHaveBeenCalledTimes(2);

        // Verify message structure
        const message1 = JSON.parse(mockSend.mock.calls[0][0]);
        const message2 = JSON.parse(mockSend.mock.calls[1][0]);

        expect(message1).toMatchObject({
          action: 'publish',
          routingKey: 'test.route1',
          payload: { data: 1 }
        });
        expect(message1.messageId).toBeDefined();
        expect(message1.messageId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); // UUID v4 format

        expect(message2).toMatchObject({
          action: 'publish',
          routingKey: 'test.route2',
          payload: { data: 2 }
        });
        expect(message2.messageId).toBeDefined();
        expect(message2.messageId).not.toBe(message1.messageId);

        // Ack both messages
        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message1.messageId,
          status: 'success'
        }));
        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message2.messageId,
          status: 'success'
        }));

        await Promise.all([sendPromise1, sendPromise2]);
      });

      it('should handle queued messages with acknowledgments', async () => {
        // Send messages while disconnected
        const sendPromise1 = client.publish('test.route1', { data: 1 });
        const sendPromise2 = client.publish('test.route2', { data: 2 });

        expect(client.getQueueSize()).toBe(2);

        // Connect and let messages flush
        triggerEvent('open');

        // Ack the flushed messages
        const message1 = JSON.parse(mockSend.mock.calls[0][0]);
        const message2 = JSON.parse(mockSend.mock.calls[1][0]);

        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message1.messageId,
          status: 'success'
        }));
        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message2.messageId,
          status: 'success'
        }));

        await Promise.all([sendPromise1, sendPromise2]);
        expect(client.getQueueSize()).toBe(0);
      });

      it('should reject queued messages when queue is cleared', async () => {
        // Queue messages
        const sendPromise1 = client.publish('test.route1', { data: 1 });
        const sendPromise2 = client.publish('test.route2', { data: 2 });

        expect(client.getQueueSize()).toBe(2);

        // Clear queue - should reject promises
        client.clearQueue();

        await expect(sendPromise1).rejects.toThrow('Message cleared from queue');
        await expect(sendPromise2).rejects.toThrow('Message cleared from queue');
        expect(client.getQueueSize()).toBe(0);
      });

      it('should reject dropped messages when queue is full', async () => {
        client.setup('ws://localhost:8080', { maxQueueSize: 2 });

        // Fill queue
        const sendPromise1 = client.publish('test.route1', { data: 1 });
        const sendPromise2 = client.publish('test.route2', { data: 2 });

        // This should drop the first message
        const sendPromise3 = client.publish('test.route3', { data: 3 });

        expect(client.getQueueSize()).toBe(2);

        // First message should be rejected
        await expect(sendPromise1).rejects.toThrow('Message dropped: queue full');

        // Connect and ack remaining messages
        triggerEvent('open');

        const message2 = JSON.parse(mockSend.mock.calls[0][0]);
        const message3 = JSON.parse(mockSend.mock.calls[1][0]);

        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message2.messageId,
          status: 'success'
        }));
        triggerEvent('message', JSON.stringify({
          type: 'ack',
          messageId: message3.messageId,
          status: 'success'
        }));

        await Promise.all([sendPromise2, sendPromise3]);
      });

      it('should flush queue on automatic reconnection with acknowledgments', async () => {
        // Set up a listener to enable auto-reconnection
        const callback = jest.fn();
        const promise = client.listen('test.key', callback);
        triggerEvent('open');
        await promise;

        // Disconnect
        triggerEvent('close');

        // Send messages while disconnected
        const sendPromise1 = client.publish('test.route1', { data: 1 });
        const sendPromise2 = client.publish('test.route2', { data: 2 });

        expect(client.getQueueSize()).toBe(2);

        // Clear previous sends
        mockSend.mockClear();

        // Trigger reconnection
        jest.advanceTimersByTime(1000);
        triggerEvent('open');

        // Advance fake timers to allow queue flush
        jest.advanceTimersByTime(0);

        // Verify messages were sent (including resubscription)
        expect(mockSend).toHaveBeenCalledTimes(3);

        // Acknowledge the queued messages
        const calls = mockSend.mock.calls;
        calls.forEach(call => {
          const message = JSON.parse(call[0]);
          if (message.messageId) {
            triggerEvent('message', JSON.stringify({
              type: 'ack',
              messageId: message.messageId,
              status: 'success'
            }));
          }
        });

        await Promise.all([sendPromise1, sendPromise2]);

        expect(client.getQueueSize()).toBe(0);

        // Verify resubscription happened
        expect(mockSend).toHaveBeenCalledWith(JSON.stringify({
          action: 'listen', bindingKey: 'test.key'
        }));
      });
    });

    describe('client-side hooks', () => {
      describe('onPublish hooks', () => {
        it('should execute onPublish hooks before sending messages', async () => {
          const hookSpy = jest.fn(async (context, message, next) => await next());
          client.setup('ws://localhost:8080', {
            hooks: { onPublish: [hookSpy] }
          });

          const promise = client.publish('test.key', { data: 'test' });
          // Small delay for async hook execution
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');

          // Acknowledge the message
          const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
          triggerEvent('message', JSON.stringify({
            type: 'ack',
            messageId: sentMessage.messageId,
            status: 'success'
          }));

          await promise;

          expect(hookSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              client
            }),
            expect.objectContaining({
              action: 'publish',
              routingKey: 'test.key',
              payload: { data: 'test' }
            }),
            expect.any(Function)
          );
        });

        it('should allow hooks to modify routingKey and payload', async () => {
          const modifyHook = jest.fn(async (context, message, next) => {
            message.routingKey = 'modified.key';
            message.payload = { modified: true };
            await next();
          });
          client.setup('ws://localhost:8080', {
            hooks: { onPublish: [modifyHook] }
          });

          const promise = client.publish('original.key', { original: true });
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');

          const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
          expect(sentMessage).toEqual({
            action: 'publish',
            routingKey: 'modified.key',
            payload: { modified: true },
            messageId: expect.any(String)
          });
        });

        it('should throw error if onPublish hook fails', async () => {
          const failingHook = jest.fn(async () => {
            throw new Error('Hook failed');
          });
          client.setup('ws://localhost:8080', {
            hooks: { onPublish: [failingHook] }
          });

          await expect(client.publish('test.key', { data: 'test' }))
            .rejects.toThrow('Hook failed');
        });

        it('should execute multiple onPublish hooks in order', async () => {
          const order: number[] = [];
          const hook1 = jest.fn(async (context, message, next) => {
            order.push(1);
            await next();
            order.push(4);
          });
          const hook2 = jest.fn(async (context, message, next) => {
            order.push(2);
            await next();
            order.push(3);
          });
          client.setup('ws://localhost:8080', {
            hooks: { onPublish: [hook1, hook2] }
          });

          const promise = client.publish('test.key', { data: 'test' });
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');

          const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
          triggerEvent('message', JSON.stringify({
            type: 'ack',
            messageId: sentMessage.messageId,
            status: 'success'
          }));

          await promise;

          expect(order).toEqual([1, 2, 3, 4]);
        });
      });

      describe('onListen hooks', () => {
        it('should execute onListen hooks before setting up listeners', async () => {
          const hookSpy = jest.fn(async (context, message, next) => await next());
          client.setup('ws://localhost:8080', {
            hooks: { onListen: [hookSpy] }
          });

          await client.listen('test.key', () => {});

          expect(hookSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              client
            }),
            expect.objectContaining({
              action: 'listen',
              bindingKey: 'test.key',
              callback: expect.any(Function)
            }),
            expect.any(Function)
          );
        });

        it('should allow hooks to modify bindingKey', async () => {
          const modifyHook = jest.fn(async (context, message, next) => {
            message.bindingKey = 'modified.key';
            await next();
          });
          client.setup('ws://localhost:8080', {
            hooks: { onListen: [modifyHook] }
          });

          const promise = client.listen('original.key', () => {});
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');
          await promise;

          expect(mockSend).toHaveBeenCalledWith(JSON.stringify({
            action: 'listen',
            bindingKey: 'modified.key'
          }));
        });

        it('should throw error if onListen hook fails', async () => {
          const failingHook = jest.fn(async () => {
            throw new Error('Hook failed');
          });
          client.setup('ws://localhost:8080', {
            hooks: { onListen: [failingHook] }
          });

          await expect(client.listen('test.key', () => {}))
            .rejects.toThrow('Hook failed');
        });
      });

      describe('onMessage hooks', () => {
        it('should execute onMessage hooks when receiving messages', async () => {
          const hookSpy = jest.fn(async (context, message, next) => await next());
          client.setup('ws://localhost:8080', {
            hooks: { onMessage: [hookSpy] }
          });

          const callback = jest.fn();
          const promise = client.listen('test.key', callback);
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');
          await promise;

          triggerEvent('message', JSON.stringify({
            type: 'message',
            bindingKey: 'test.key',
            payload: { data: 'test' }
          }));

          await new Promise(resolve => setTimeout(resolve, 0));

          expect(hookSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              client
            }),
            expect.objectContaining({
              action: 'message',
              bindingKey: 'test.key',
              payload: { data: 'test' }
            }),
            expect.any(Function)
          );
          expect(callback).toHaveBeenCalledWith({ data: 'test' });
        });

        it('should allow hooks to modify payload before callbacks', async () => {
          const modifyHook = jest.fn(async (context, message, next) => {
            message.payload = { modified: true };
            await next();
          });
          client.setup('ws://localhost:8080', {
            hooks: { onMessage: [modifyHook] }
          });

          const callback = jest.fn();
          const promise = client.listen('test.key', callback);
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');
          await promise;

          triggerEvent('message', JSON.stringify({
            type: 'message',
            bindingKey: 'test.key',
            payload: { original: true }
          }));

          await new Promise(resolve => setTimeout(resolve, 0));

          expect(callback).toHaveBeenCalledWith({ modified: true });
        });

        it('should skip callbacks if onMessage hook fails', async () => {
          const failingHook = jest.fn(async () => {
            throw new Error('Hook failed');
          });
          client.setup('ws://localhost:8080', {
            hooks: { onMessage: [failingHook] }
          });

          const callback = jest.fn();
          const promise = client.listen('test.key', callback);
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');
          await promise;

          triggerEvent('message', JSON.stringify({
            type: 'message',
            bindingKey: 'test.key',
            payload: { data: 'test' }
          }));

          await new Promise(resolve => setTimeout(resolve, 0));

          expect(callback).not.toHaveBeenCalled();
        });
      });

      describe('pre hooks', () => {
        it('should execute pre hooks before action-specific hooks', async () => {
          const order: string[] = [];
          const preHook = jest.fn(async (context, message, next) => {
            order.push('pre');
            await next();
          });
          const publishHook = jest.fn(async (context, message, next) => {
            order.push('onPublish');
            await next();
          });
          client.setup('ws://localhost:8080', {
            hooks: {
              pre: [preHook],
              onPublish: [publishHook]
            }
          });

          const promise = client.publish('test.key', { data: 'test' });
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');

          const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
          triggerEvent('message', JSON.stringify({
            type: 'ack',
            messageId: sentMessage.messageId,
            status: 'success'
          }));

          await promise;

          expect(order).toEqual(['pre', 'onPublish']);
        });

        it('should allow pre hooks to modify context for all actions', async () => {
          const contextEnhancingHook = jest.fn(async (context, message, next) => {
            context.enhanced = true;
            await next();
          });
          const publishHook = jest.fn(async (context, message, next) => {
            expect(context.enhanced).toBe(true);
            await next();
          });
          client.setup('ws://localhost:8080', {
            hooks: {
              pre: [contextEnhancingHook],
              onPublish: [publishHook]
            }
          });

          const promise = client.publish('test.key', { data: 'test' });
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');

          const sentMessage = JSON.parse(mockSend.mock.calls[0][0]);
          triggerEvent('message', JSON.stringify({
            type: 'ack',
            messageId: sentMessage.messageId,
            status: 'success'
          }));

          await promise;

          expect(contextEnhancingHook).toHaveBeenCalled();
          expect(publishHook).toHaveBeenCalled();
        });
      });

      describe('persistent context', () => {
        it('should maintain context across different hook calls', async () => {
          let savedContext: any;
          const preHook = jest.fn(async (context, message, next) => {
            context.sessionId = 'test-session';
            savedContext = context;
            await next();
          });
          client.setup('ws://localhost:8080', {
            hooks: { pre: [preHook] }
          });

          // First action
          const promise1 = client.publish('test.key1', { data: 1 });
          await new Promise(resolve => setTimeout(resolve, 0));
          triggerEvent('open');

          const sentMessage1 = JSON.parse(mockSend.mock.calls[0][0]);
          triggerEvent('message', JSON.stringify({
            type: 'ack',
            messageId: sentMessage1.messageId,
            status: 'success'
          }));

          await promise1;

          // Second action - context should persist
          mockSend.mockClear();
          const promise2 = client.listen('test.key2', () => {});
          await promise2;

          expect(preHook).toHaveBeenCalledTimes(2);
          // Both calls should use the same context object
          expect(preHook.mock.calls[1][0]).toBe(savedContext);
          expect(preHook.mock.calls[1][0].sessionId).toBe('test-session');
        });
      });
    });
  });
});
