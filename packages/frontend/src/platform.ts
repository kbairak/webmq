class EventTargetPolyfill {
  _listeners: Record<string, Set<Function>> = {};
  addEventListener(type: string, listener: Function) {
    if (!this._listeners[type]) this._listeners[type] = new Set();
    this._listeners[type].add(listener);
  }
  removeEventListener(type: string, listener: Function) {
    this._listeners[type]?.delete(listener);
  }
  dispatchEvent(event: { type: string }) {
    this._listeners[event.type]?.forEach((fn) => fn(event));
  }
}

class EventPolyfill {
  type: string;
  constructor(type: string, _init: any = {}) { this.type = type; }
}

class CustomEventPolyfill extends EventPolyfill {
  detail: any;
  constructor(type: string, init: any = {}) {
    super(type, init);
    this.detail = init.detail ?? null;
  }
}

class CloseEventPolyfill extends EventPolyfill {
  code: number;
  reason: string;
  wasClean: boolean;
  constructor(type: string, init: any = {}) {
    super(type, init);
    this.code = init.code;
    this.reason = init.reason;
    this.wasClean = init.wasClean;
  }
}

class MessageEventPolyfill extends EventPolyfill {
  data: any;
  origin: string;
  lastEventId: string;
  source: any;
  ports: any[];
  constructor(type: string, init: any = {}) {
    super(type, init);
    this.data = init.data;
    this.origin = init.origin;
    this.lastEventId = init.lastEventId;
    this.source = init.source;
    this.ports = init.ports ? [...init.ports] : [];
  }
}

class TextEncoderPolyfill {
  encode(str: string): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
      let code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0xd800 || code >= 0xe000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        i++;
        code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return new Uint8Array(bytes);
  }
  encodeInto(str: string, dest: Uint8Array): { read: number; written: number } {
    const encoded = this.encode(str);
    const len = Math.min(encoded.length, dest.length);
    dest.set(encoded.subarray(0, len));
    return { read: str.length, written: len };
  }
}

class TextDecoderPolyfill {
  encoding: string = 'utf-8';
  fatal: boolean = false;
  ignoreBOM: boolean = false;
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) {
    this.encoding = label?.toLowerCase() ?? 'utf-8';
    this.fatal = options?.fatal ?? false;
    this.ignoreBOM = options?.ignoreBOM ?? false;
  }
  decode(buffer?: ArrayBufferView | ArrayBuffer, _options?: { stream?: boolean }): string {
    if (!buffer) return '';
    const bytes = buffer instanceof Uint8Array ? buffer : ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
    let result = '';
    let i = 0;
    while (i < bytes.length) {
      const byte = bytes[i];
      let code: number;
      if (byte < 0x80) {
        code = byte;
        i += 1;
      } else if (byte < 0xe0) {
        code = ((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
        i += 2;
      } else if (byte < 0xf0) {
        code = ((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
        i += 3;
      } else {
        code = ((byte & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        i += 4;
      }
      result += String.fromCodePoint(code);
    }
    return result;
  }
}

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoderPolyfill as any;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoderPolyfill as any;
}

export type BinaryType = 'blob' | 'arraybuffer';

function getRNAppState(): any | null {
  try {
    const { AppState } = require('react-native');
    return AppState;
  } catch {
    return null;
  }
}

export function onReconnectSignal(callback: () => void): () => void {
  const cleanups: (() => void)[] = [];
  const rnAppState = getRNAppState();

  if (rnAppState) {
    const subscription = rnAppState.addEventListener('change', (nextState: string) => {
      if (nextState === 'active') callback();
    });
    cleanups.push(() => subscription.remove());
  }

  if (typeof globalThis.window?.addEventListener === 'function' && typeof globalThis.document?.addEventListener === 'function') {
    const onOnline = () => callback();
    globalThis.window.addEventListener('online', onOnline);
    cleanups.push(() => globalThis.window.removeEventListener('online', onOnline));

    const onVisible = () => {
      if (globalThis.document.visibilityState === 'visible') callback();
    };
    globalThis.document.addEventListener('visibilitychange', onVisible);
    cleanups.push(() => globalThis.document.removeEventListener('visibilitychange', onVisible));
  }

  return () => { for (const fn of cleanups) fn(); };
}

export function onUnload(callback: () => void): () => void {
  const cleanups: (() => void)[] = [];

  if (typeof globalThis.window?.addEventListener === 'function') {
    globalThis.window.addEventListener('beforeunload', callback);
    cleanups.push(() => globalThis.window.removeEventListener('beforeunload', callback));
  }

  return () => { for (const fn of cleanups) fn(); };
}

export {
  EventTargetPolyfill as EventTarget,
  EventPolyfill as Event,
  CustomEventPolyfill as CustomEvent,
  CloseEventPolyfill as CloseEvent,
  MessageEventPolyfill as MessageEvent,
};
