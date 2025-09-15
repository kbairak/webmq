import { WebMQClient, setup, listen, emit, unlisten, connect } from './index';

// Mock WebSocket
const mockSend = jest.fn();
const mockClose = jest.fn();
let mockServer = {
  onmessage: (event: { data: string }) => {},
  onopen: () => {},
  onclose: () => {},
  onerror: (error: Error) => {},
};

global.WebSocket = jest.fn().mockImplementation((url) => {
  const wsInstance = {
    url,
    send: mockSend,
    close: mockClose,
    set onmessage(callback: (event: { data: string }) => void) { mockServer.onmessage = callback; },
    set onopen(callback: () => void) { mockServer.onopen = callback; },
    set onclose(callback: () => void) { mockServer.onclose = callback; },
    set onerror(callback: (error: Error) => void) { mockServer.onerror = callback; },
  };
  return wsInstance;
}) as any;

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
      const promise = client.listen('test.key', () => {});
      // Simulate server connection
      mockServer.onopen();
      await promise;

      expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8080');
      expect(mockSend).toHaveBeenCalledWith(JSON.stringify({ action: 'listen', bindingKey: 'test.key' }));
    });

    it('should only send one listen message for multiple listeners on the same key', async () => {
      const promise = client.listen('test.key', () => {});
      mockServer.onopen();
      await promise;

      await client.listen('test.key', () => {});

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch messages to the correct callback', async () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      const promise = client.listen('test.key', callback1);
      mockServer.onopen();
      await promise;
      await client.listen('another.key', callback2);

      const message = { type: 'message', bindingKey: 'test.key', payload: { data: 'hello' } };
      mockServer.onmessage({ data: JSON.stringify(message) });

      expect(callback1).toHaveBeenCalledWith({ data: 'hello' });
      expect(callback2).not.toHaveBeenCalled();
    });

    it('should send unlisten message when the last callback is removed', async () => {
      const callback = () => {};
      const promise = client.listen('test.key', callback);
      mockServer.onopen();
      await promise;

      // Now unlisten
      await client.unlisten('test.key', callback);

      expect(mockSend).toHaveBeenCalledWith(JSON.stringify({ action: 'unlisten', bindingKey: 'test.key' }));
    });

    it('should NOT send unlisten message if other callbacks still exist', async () => {
      const callback1 = () => {};
      const callback2 = () => {};
      const promise = client.listen('test.key', callback1);
      mockServer.onopen();
      await promise;
      await client.listen('test.key', callback2);

      // Clear mock from the initial listen call
      mockSend.mockClear();

      await client.unlisten('test.key', callback1);

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should send an emit message', async () => {
      const promise = client.emit('test.route', { data: 123 });
      mockServer.onopen();
      await promise;

      expect(mockSend).toHaveBeenCalledWith(JSON.stringify({ action: 'emit', routingKey: 'test.route', payload: { data: 123 } }));
    });
  });
});
