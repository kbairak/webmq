export function createMockWebSocket() {
  const listeners = new Map<string, Set<Function>>();

  return {
    addEventListener: jest.fn((type: string, listener: Function) => {
      if (!listeners.has(type)) { listeners.set(type, new Set()); }
      listeners.get(type)?.add(listener);
    }),

    removeEventListener: jest.fn((type: string, listener: Function) => {
      listeners.get(type)?.delete(listener);
    }),

    dispatchEvent: jest.fn((event: Event) => {
      listeners.get(event.type)?.forEach((fn) => fn(event));
    }),

    send: jest.fn(),
    close: jest.fn(),

    binaryType: 'arraybuffer' as BinaryType,
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    extensions: '',
    protocol: '',
    url: '',
  };
}
