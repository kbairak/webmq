import WebMQClient from '../src/index';
import type { ServerMessageHeader } from '../src/index';
import { io } from 'socket.io-client';
import { bundleData } from '../src/bundle';

jest.mock('socket.io-client');

interface MockSocket {
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  _eventHandlers: Map<string, Set<Function>>;
}

function createMockSocket(): MockSocket {
  const eventHandlers = new Map<string, Set<Function>>();
  const socket: MockSocket = {
    on: jest.fn((event: string, handler: Function) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
      eventHandlers.get(event)!.add(handler);
      return socket;
    }),
    off: jest.fn((event: string, handler: Function) => {
      eventHandlers.get(event)?.delete(handler);
      return socket;
    }),
    emit: jest.fn(),
    disconnect: jest.fn(),
    _eventHandlers: eventHandlers,
  };
  return socket;
}

describe('WebMQClient', () => {
  let mockSocket: MockSocket;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSocket = createMockSocket();
    (io as jest.Mock).mockReturnValue(mockSocket);
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Constructor', () => {
    it('should initialize with url and sessionId', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
      });
      expect(client.url).toBe('http://localhost:3000');
      expect(client.sessionId).toBe('test-session');
      expect(client.logLevel).toBe('INFO');
    });

    it('should apply custom logLevel', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'DEBUG',
      });
      expect(client.logLevel).toBe('DEBUG');
    });
  });

  describe('connect()', () => {
    it('should create Socket.IO connection with auth', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
      });
      client.connect();
      expect(io).toHaveBeenCalledWith('http://localhost:3000', {
        auth: { sessionId: 'test-session' },
        reconnectionDelay: 500,
        reconnectionDelayMax: 2000,
      });
    });

    it('should set up message listener', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
      });
      client.connect();
      expect(mockSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  describe('disconnect()', () => {
    it('should disconnect Socket.IO connection', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
      });
      client.connect();
      client.disconnect();
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });
  });

  describe('publish()', () => {
    it('should send ArrayBuffer payloads', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const payload = new TextEncoder().encode('Hello World').buffer;
      client.publish('test.route', payload);
      expect(mockSocket.emit).toHaveBeenCalledWith('publish', expect.any(Uint8Array));
    });

    it('should send JSON payloads', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      client.publish('test.route', { message: 'Hello World' });
      expect(mockSocket.emit).toHaveBeenCalledWith('publish', expect.any(Uint8Array));
    });
  });

  describe('listen()', () => {
    it('should subscribe to bindingKey', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.*', callback);
      expect(mockSocket.emit).toHaveBeenCalledWith('listen', expect.any(Uint8Array));
    });

    it('should decode and parse JSON payloads', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.*', callback);

      const messageHandler = Array.from(mockSocket._eventHandlers.get('message')!)[0] as (data: ArrayBuffer, ack: () => void) => void;
      const payload = new TextEncoder().encode('{"message":"Hello"}').buffer;
      const header: ServerMessageHeader = { routingKey: 'events.test' };
      const bundled = new Uint8Array(bundleData(header, payload)).buffer;
      const ack = jest.fn();

      messageHandler(bundled, ack);

      expect(callback).toHaveBeenCalledWith({ message: 'Hello' });
      expect(ack).toHaveBeenCalled();
    });

    it('should handle multiple callbacks per binding', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      client.listen('events.*', callback1);
      client.listen('events.*', callback2);
      expect(mockSocket.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('listen() - Raw mode', () => {
    it('should pass raw ArrayBuffer to callback', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.*', callback, false);

      const messageHandler = Array.from(mockSocket._eventHandlers.get('message')!)[0] as (data: ArrayBuffer, ack: () => void) => void;
      const payload = new TextEncoder().encode('raw data').buffer;
      const header: ServerMessageHeader = { routingKey: 'events.test' };
      const bundled = new Uint8Array(bundleData(header, payload)).buffer;

      messageHandler(bundled, jest.fn());

      expect(callback).toHaveBeenCalledWith(payload);
    });
  });

  describe('unlisten()', () => {
    it('should remove specific callback', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.*', callback);
      client.unlisten('events.*', callback);

      const messageHandler = Array.from(mockSocket._eventHandlers.get('message')!)[0] as (data: ArrayBuffer, ack: () => void) => void;
      const payload = new TextEncoder().encode('{}').buffer;
      const header: ServerMessageHeader = { routingKey: 'events.test' };
      const bundled = new Uint8Array(bundleData(header, payload)).buffer;

      messageHandler(bundled, jest.fn());

      expect(callback).not.toHaveBeenCalled();
    });

    it('should send backend unlisten request on last removal', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.*', callback);
      mockSocket.emit.mockClear();
      client.unlisten('events.*', callback);
      expect(mockSocket.emit).toHaveBeenCalledWith('unlisten', expect.any(Uint8Array));
    });
  });

  describe('Pattern Matching', () => {
    it('should match exact routing keys', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.test', callback);

      const messageHandler = Array.from(mockSocket._eventHandlers.get('message')!)[0] as (data: ArrayBuffer, ack: () => void) => void;
      const payload = new TextEncoder().encode('{}').buffer;
      const header: ServerMessageHeader = { routingKey: 'events.test' };
      const bundled = new Uint8Array(bundleData(header, payload)).buffer;

      messageHandler(bundled, jest.fn());

      expect(callback).toHaveBeenCalled();
    });

    it('should match * wildcard', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.*', callback);

      const messageHandler = Array.from(mockSocket._eventHandlers.get('message')!)[0] as (data: ArrayBuffer, ack: () => void) => void;
      const payload = new TextEncoder().encode('{}').buffer;

      const header1: ServerMessageHeader = { routingKey: 'events.test' };
      messageHandler(new Uint8Array(bundleData(header1, payload)).buffer, jest.fn());

      const header2: ServerMessageHeader = { routingKey: 'events.another' };
      messageHandler(new Uint8Array(bundleData(header2, payload)).buffer, jest.fn());

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should match # wildcard', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.#', callback);

      const messageHandler = Array.from(mockSocket._eventHandlers.get('message')!)[0] as (data: ArrayBuffer, ack: () => void) => void;
      const payload = new TextEncoder().encode('{}').buffer;

      const header1: ServerMessageHeader = { routingKey: 'events.test.sub' };
      messageHandler(new Uint8Array(bundleData(header1, payload)).buffer, jest.fn());

      const header2: ServerMessageHeader = { routingKey: 'events.a.b.c' };
      messageHandler(new Uint8Array(bundleData(header2, payload)).buffer, jest.fn());

      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('Hook System', () => {
    it('should execute hooks in order', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      const executionOrder: string[] = [];
      client.addHook('pre', (header) => {
        executionOrder.push('pre');
        return header;
      });
      client.addHook('publish', (header) => {
        executionOrder.push('publish');
        return header;
      });
      client.addHook('post', (header) => {
        executionOrder.push('post');
        return header;
      });
      client.connect();
      client.publish('test.route', { data: 'test' });
      expect(executionOrder).toEqual(['pre', 'publish', 'post']);
    });
  });

  describe('addHook/removeHook', () => {
    it('should add hooks for all types', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
      });
      const hook = jest.fn((header) => header);
      expect(() => {
        client.addHook('pre', hook);
        client.addHook('post', hook);
        client.addHook('publish', hook);
        client.addHook('listen', hook);
        client.addHook('unlisten', hook);
        client.addHook('message', hook);
      }).not.toThrow();
    });

    it('should remove hooks correctly', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      const hook = jest.fn((header) => header);
      client.addHook('publish', hook);
      client.removeHook('publish', hook);
      client.connect();
      client.publish('test.route', { data: 'test' });
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe('Socket.IO Event Proxying', () => {
    it('should proxy on() to socket', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
      });
      client.connect();
      const handler = jest.fn();
      client.on('connect', handler);
      expect(mockSocket.on).toHaveBeenCalledWith('connect', handler);
    });

    it('should throw if not connected when calling on()', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
      });
      expect(() => client.on('connect', jest.fn())).toThrow(
        'WebMQClient is not connected. Call connect() before adding listeners.'
      );
    });
  });

  describe('Logging', () => {
    it('should filter by log level', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'WARNING',
      });
      client.connect();
      const logs = (console.log as jest.Mock).mock.calls;
      const hasInfoLogs = logs.some((call) => call[0]?.includes('[INFO]'));
      expect(hasInfoLogs).toBe(false);
    });

    it('should suppress all logs at SILENT level', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      expect(console.log).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle parse errors gracefully', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.*', callback);

      const messageHandler = Array.from(mockSocket._eventHandlers.get('message')!)[0] as (data: ArrayBuffer, ack: () => void) => void;
      const invalidData = new ArrayBuffer(4);

      expect(() => messageHandler(invalidData, jest.fn())).not.toThrow();
      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle missing routingKey', () => {
      const client = new WebMQClient({
        url: 'http://localhost:3000',
        sessionId: 'test-session',
        logLevel: 'SILENT',
      });
      client.connect();
      const callback = jest.fn();
      client.listen('events.*', callback);

      const messageHandler = Array.from(mockSocket._eventHandlers.get('message')!)[0] as (data: ArrayBuffer, ack: () => void) => void;
      const header = { bindingKey: 'test' } as any;
      const bundled = new Uint8Array(bundleData(header)).buffer;

      expect(() => messageHandler(bundled, jest.fn())).not.toThrow();
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
