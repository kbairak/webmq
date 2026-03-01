import ReconnectingWebSocket from '../src/ReconnectingWebSocket'
import { createMockWebSocket } from './utils'

describe('ReconnectingWebSocket', () => {
  let mockWs: ReturnType<typeof createMockWebSocket>;
  let MockWebSocketClass: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWs = createMockWebSocket();
    MockWebSocketClass = jest.fn(() => mockWs);
    global.WebSocket = MockWebSocketClass as any;
  });

  it('should construct', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    expect(w.url).toBe('ws://example.com');
    expect(mockWs.addEventListener).toHaveBeenCalledTimes(4);
  });

  it('should dispatch open', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let received = false;
    w.addEventListener('open', () => { received = true; });
    mockWs.dispatchEvent(new Event('open'));
    expect(received).toBe(true);
  });

  it('should close', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    w.close(1234, 'dumb_reason');
    expect((w as any)._shouldReconnect).toBe(false);
    expect(mockWs.close).toHaveBeenCalledWith(1234, 'dumb_reason');
  });

  it('should attempt reconnect', async () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let received = false;
    w.addEventListener('reconnecting', () => { received = true; });
    mockWs.dispatchEvent(new CloseEvent('close'));
    expect(received).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(MockWebSocketClass).toHaveBeenCalledTimes(2);
    expect((w as any)._reconnectAttempts).toBe(1);
  })

  it('should succeed reconnect', async () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    mockWs.dispatchEvent(new CloseEvent('close'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    let received = false;
    w.addEventListener('reconnected', () => { received = true; });
    mockWs.dispatchEvent(new Event('open'));
    expect(received).toBe(true);
    expect((w as any)._reconnectAttempts).toBe(0);
  })

  it('should forward error event', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let received = false;
    w.addEventListener('error', () => { received = true; });
    mockWs.dispatchEvent(new Event('error'));
    expect(received).toBe(true);
  });

  it('should forward message event', () => {
    const w = new ReconnectingWebSocket('ws://example.com');
    let received = false;
    w.addEventListener('message', () => { received = true; });
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
