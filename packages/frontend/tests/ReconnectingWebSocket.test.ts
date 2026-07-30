import ReconnectingWebSocket from '../src/ReconnectingWebSocket';
import { createMockWebSocket } from './utils';

describe('ReconnectingWebSocket', () => {
  let mockWs: ReturnType<typeof createMockWebSocket>;
  let MockWebSocketClass: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockWs = createMockWebSocket();
    MockWebSocketClass = jest.fn(() => mockWs);
    global.WebSocket = MockWebSocketClass as any;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should construct', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    expect(w.url).toBe('ws://example.com');
    expect(mockWs.addEventListener).toHaveBeenCalledTimes(4);
  });

  it('should dispatch open', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let received = false;
    w.addEventListener('open', () => {
      received = true;
    });
    mockWs.dispatchEvent(new Event('open'));
    expect(received).toBe(true);
  });

  it('should close', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    w.close(1234, 'dumb_reason');
    expect((w as any)._shouldReconnect).toBe(false);
    expect(mockWs.close).toHaveBeenCalledWith(1234, 'dumb_reason');
  });

  it('should attempt reconnect', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    const ws = (w as any)._ws;
    let received = false;
    let attempt = 0;
    w.addEventListener('reconnecting', (event: Event) => {
      received = true;
      attempt = (event as CustomEvent).detail.attempt;
    });
    ws.dispatchEvent(new CloseEvent('close'));
    expect(received).toBe(true);
    expect(attempt).toBe(1);
    jest.advanceTimersByTime(1);
    expect((w as any)._reconnectAttempts).toBe(1);
  });

  it('should succeed reconnect', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let ws = (w as any)._ws;
    ws.dispatchEvent(new CloseEvent('close'));
    jest.advanceTimersByTime(1);
    ws = (w as any)._ws;
    let received = false;
    w.addEventListener('reconnected', () => {
      received = true;
    });
    ws.dispatchEvent(new Event('open'));
    expect(received).toBe(true);
    expect((w as any)._reconnectAttempts).toBe(0);
  });

  it('should retry forever with capped backoff', () => {
    const w = new ReconnectingWebSocket('ws://example.com', [0, 1000, 2000]);
    let ws = (w as any)._ws;
    ws.dispatchEvent(new CloseEvent('close'));
    jest.advanceTimersByTime(1);
    ws = (w as any)._ws;
    ws.dispatchEvent(new CloseEvent('close'));
    jest.advanceTimersByTime(1000);
    ws = (w as any)._ws;
    ws.dispatchEvent(new CloseEvent('close'));
    jest.advanceTimersByTime(2000);
    ws = (w as any)._ws;
    ws.dispatchEvent(new CloseEvent('close'));
    jest.advanceTimersByTime(2000);
    ws = (w as any)._ws;
    expect(ws).toBeDefined();
  });

  it('should persist binaryType across reconnect', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let ws = (w as any)._ws;
    w.binaryType = 'arraybuffer';
    expect(ws.binaryType).toBe('arraybuffer');
    expect(w.binaryType).toBe('arraybuffer');
    ws.dispatchEvent(new CloseEvent('close'));
    jest.advanceTimersByTime(1);
    ws = (w as any)._ws;
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('forceReconnect should replace socket immediately', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    w.forceReconnect();
    expect(MockWebSocketClass).toHaveBeenCalledTimes(2);
    expect((w as any)._reconnectAttempts).toBe(0);
  });

  it('forceReconnect should skip waiting reconnect timer', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    mockWs.dispatchEvent(new CloseEvent('close'));
    (w as any)._reconnectAttempts = 0;
    w.forceReconnect();
    expect((w as any)._reconnectTimer).toBeNull();
    expect(MockWebSocketClass).toHaveBeenCalledTimes(2);
  });

  it('close should cancel pending reconnect timer', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    mockWs.dispatchEvent(new CloseEvent('close'));
    expect((w as any)._reconnectTimer).not.toBeNull();
    w.close(1000, 'bye');
    expect((w as any)._reconnectTimer).toBeNull();
    expect((w as any)._shouldReconnect).toBe(false);
  });

  it('should forward error event', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let received = false;
    w.addEventListener('error', () => {
      received = true;
    });
    mockWs.dispatchEvent(new Event('error'));
    expect(received).toBe(true);
  });

  it('should forward message event', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let received = false;
    w.addEventListener('message', () => {
      received = true;
    });
    mockWs.dispatchEvent(new MessageEvent('message'));
    expect(received).toBe(true);
  });

  it('should forward send', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    w.send('hello');
    expect(mockWs.send).toHaveBeenCalledWith('hello');
  });

  it('should forward binaryType', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    w.binaryType = 'blob';
    expect(mockWs.binaryType).toBe('blob');
    expect(w.binaryType).toBe('blob');
  });

  it('should forward bufferedAmount', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    mockWs.bufferedAmount = 42;
    expect(w.bufferedAmount).toBe(42);
  });

  it('should forward extensions', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    mockWs.extensions = 'foo';
    expect(w.extensions).toBe('foo');
  });

  it('should forward protocol', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    mockWs.protocol = 'foo';
    expect(w.protocol).toBe('foo');
  });

  it('should forward readyState', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    expect(w.readyState).toBe(WebSocket.OPEN);
  });
});
