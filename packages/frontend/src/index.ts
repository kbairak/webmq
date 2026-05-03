import { io, Socket } from 'socket.io-client';
import { bundleData, unbundleData } from './bundle';

type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT';
interface WebMQClientOptions {
  url: string;
  sessionId: string;
  logLevel?: LogLevel;
}
interface ServerMessageHeader {
  routingKey: string;
  [key: string]: JsonSerializable;
}
interface ClientMessageHeader {
  routingKey?: string;
  bindingKey?: string;
  [key: string]: any;
}
type MessageHeader = ClientMessageHeader | ServerMessageHeader;
type HookName = 'pre' | 'identify' | 'publish' | 'listen' | 'unlisten' | 'message' | 'post';
type HookFunction<T extends MessageHeader> = (header: T) => T;
type JsonSerializable =
  | string
  | number
  | boolean
  | null
  | JsonSerializable[]
  | { [key: string]: JsonSerializable };

export {
  WebMQClientOptions,
  ClientMessageHeader,
  ServerMessageHeader,
  MessageHeader,
  HookName,
  HookFunction,
  JsonSerializable,
};

export default class WebMQClient {
  readonly url: string;
  readonly sessionId: string;
  public logLevel: LogLevel = 'INFO';
  private _socket: Socket | null = null;
  private _messageListeners = new Map<string, Map<(payload: any) => void, boolean>>();
  private _hooks = {
    pre: new Set<HookFunction<MessageHeader>>(),
    identify: new Set<HookFunction<ClientMessageHeader>>(),
    publish: new Set<HookFunction<ClientMessageHeader>>(),
    listen: new Set<HookFunction<ClientMessageHeader>>(),
    unlisten: new Set<HookFunction<ClientMessageHeader>>(),
    message: new Set<HookFunction<ServerMessageHeader>>(),
    post: new Set<HookFunction<MessageHeader>>(),
  };

  constructor(options: WebMQClientOptions) {
    this.url = options.url;
    this.sessionId = options.sessionId;
    if (options.logLevel) {
      this.logLevel = options.logLevel;
    }
    this._log('DEBUG', 'WebMQClient instance created');
  }

  public connect() {
    this._log('INFO', `WebMQClient connecting to ${this.url}`);
    this._socket = io(this.url, {
      auth: { sessionId: this.sessionId },
      reconnectionDelay: 500,      // Start reconnecting after 500ms
      reconnectionDelayMax: 2000,  // Max delay between attempts
    });

    this._socket.on('message', (data: ArrayBuffer, ack: () => void) => {
      let header: ServerMessageHeader, payload: ArrayBuffer | undefined;
      if (!(data instanceof ArrayBuffer)) {
        this._log('WARNING', 'Received message in unsupported format');
        return;
      }
      try {
        [header, payload] = unbundleData(data);
        this._log('DEBUG', 'Received message', header);
      } catch (err) {
        this._log('WARNING', 'Failed to parse incoming message', err);
        return;
      }
      if (!header.routingKey) {
        this._log('WARNING', 'Received message without routingKey');
        return;
      }
      [...this._messageListeners.keys()]
        .filter((bindingKey) => matchesPattern(header.routingKey!, bindingKey))
        .forEach((bindingKey) => {
          this._messageListeners.get(bindingKey)?.forEach((isJson, callback) => {
            if (isJson) {
              const decoder = new TextDecoder();
              const payloadString = decoder.decode(payload);
              const decodedPayload = JSON.parse(payloadString);
              callback(decodedPayload);
            } else {
              callback(payload);
            }
          });
        });

      // Acknowledge message receipt to backend
      if (ack) ack();
    });
    // Graceful shutdown on page unload
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', () => {
        this.disconnect();
      });
    }
  }

  public disconnect() {
    this._socket?.disconnect();
  }

  public publish(routingKey: string, payload: ArrayBuffer | JsonSerializable) {
    this._log('DEBUG', `Publishing message with routingKey: ${routingKey}`);
    const actualPayload =
      payload instanceof ArrayBuffer
        ? payload
        : new TextEncoder().encode(JSON.stringify(payload)).buffer;
    try {
      const header = this._runHooks(['pre', 'publish', 'post'], { routingKey });
      const bundled = bundleData(header, actualPayload);
      this._socket?.emit('publish', bundled);
    } catch (error) {
      this._log('error', 'Error sending message', error);
    }
  }

  public listen(
    bindingKey: string,
    callback: (payload: JsonSerializable) => void,
    isJson?: true
  ): void;
  public listen(bindingKey: string, callback: (payload: ArrayBuffer) => void, isJson: false): void;
  public listen(bindingKey: string, callback: (payload: any) => void, isJson?: boolean) {
    this._log('INFO', `Adding listener for bindingKey: ${bindingKey}`);
    let callbacks = this._messageListeners.get(bindingKey);
    if (!callbacks) {
      callbacks = new Map<(payload: any) => void, boolean>();
      this._messageListeners.set(bindingKey, callbacks);
    }
    if (!callbacks.has(callback)) {
      callbacks.set(callback, isJson ?? true);
      // Only send to backend if this is the first listener for this bindingKey
      if (callbacks.size === 1) {
        this._log('INFO', `First callback for bindingKey ${bindingKey}; sending listen request`);
        try {
          const header = this._runHooks(['pre', 'listen', 'post'], { bindingKey });
          const bundled = bundleData(header);
          this._socket?.emit('listen', bundled);
        } catch (error) {
          this._log('error', 'Error sending message', error);
        }
      }
    }
  }

  public listenRaw(bindingKey: string, callback: (payload: any) => void) {
    this.listen(bindingKey, callback, false);
  }

  public listenJson(bindingKey: string, callback: (payload: any) => void) {
    this.listen(bindingKey, callback, true);
  }

  public unlisten(bindingKey: string, callback: (payload: any) => void) {
    this._log('INFO', `Removing listener for bindingKey: ${bindingKey}`);
    const callbacks = this._messageListeners.get(bindingKey);
    if (!callbacks || !callbacks.has(callback)) {
      return;
    }
    callbacks.delete(callback);
    if (callbacks.size === 0) {
      this._log('INFO', `No more callbacks for bindingKey ${bindingKey}; sending unlisten request`);
      this._messageListeners.delete(bindingKey); // Clean up empty Map
      try {
        const header = this._runHooks(['pre', 'unlisten', 'post'], { bindingKey });
        const bundled = bundleData(header);
        this._socket?.emit('unlisten', bundled);
      } catch (error) {
        this._log('error', 'Error sending message', error);
      }
    }
  }

  public addHook(action: 'pre' | 'post', hook: HookFunction<MessageHeader>): void;
  public addHook(
    action: 'identify' | 'publish' | 'listen' | 'unlisten',
    hook: HookFunction<ClientMessageHeader>
  ): void;
  public addHook(action: 'message', hook: HookFunction<ServerMessageHeader>): void;
  public addHook(action: HookName, hook: HookFunction<any>): void {
    this._log('INFO', `Adding hook for action: ${action}`);
    this._hooks[action].add(hook);
  }

  public removeHook(action: 'pre' | 'post', hook: HookFunction<MessageHeader>): void;
  public removeHook(
    action: 'identify' | 'publish' | 'listen' | 'unlisten',
    hook: HookFunction<ClientMessageHeader>
  ): void;
  public removeHook(action: 'message', hook: HookFunction<ServerMessageHeader>): void;
  public removeHook(action: HookName, hook: HookFunction<any>): void {
    this._log('INFO', `Removing hook for action: ${action}`);
    this._hooks[action].delete(hook);
  }

  private _runHooks<T extends MessageHeader>(hookName: HookName | HookName[], header: T) {
    let result: MessageHeader = header;
    if (Array.isArray(hookName)) {
      for (const name of hookName) {
        result = this._runHooks(name, result);
      }
    } else {
      const hooks = this._hooks[hookName] as Set<HookFunction<MessageHeader>>;
      let result: MessageHeader = header;
      for (const hook of hooks) {
        result = hook(result);
        if (result === undefined) {
          throw new Error(`Hook ${hookName} did not return a header object`);
        }
      }
    }
    return result as T;
  }

  private _log(logLevel: string, message: any, err?: any) {
    const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'SILENT'];
    const instanceLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(logLevel);
    if (messageLevelIndex >= instanceLevelIndex) {
      if (typeof message === 'string') {
        console.log(`[${logLevel}]: ${message}`);
      } else {
        console.log([logLevel, message]);
      }
    }
    if (err) {
      this._log('DEBUG', err);
    }
  }

  // Map `on` and `off` to underlying socket's `on` and `off`
  public on(...args: Parameters<Socket['on']>): ReturnType<Socket['on']> {
    if (!this._socket) {
      throw new Error('WebMQClient is not connected. Call connect() before adding listeners.');
    }
    return this._socket.on(...args);
  }

  public off(...args: Parameters<Socket['on']>): ReturnType<Socket['on']> {
    if (!this._socket) {
      throw new Error('WebMQClient is not connected. Call connect() before adding listeners.');
    }
    return this._socket.off(...args);
  }
}

function matchesPattern(routingKey: string, bindingKey: string): boolean {
  const regexPattern = bindingKey
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*/g, '[^.]+') // * matches one or more non-dots
    .replace(/#/g, '.*'); // # matches zero or more of any character
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(routingKey);
}
