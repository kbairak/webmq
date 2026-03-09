import { v4 as uuid } from 'uuid';
import ReconnectingWebSocket from './ReconnectingWebSocket';
import { bundleData, unbundleData } from './bundle';

// Types
interface ClientMessageHeader {
  action: 'identify' | 'publish' | 'listen' | 'unlisten';
  messageId?: string;
  routingKey?: string;
  bindingKey?: string;
  [key: string]: any;
}
interface ServerMessageHeader {
  messageId?: string;
  routingKey?: string;
  [key: string]: any;
}
type MessageHeader = ClientMessageHeader | ServerMessageHeader;

type HookName =
  | 'pre'
  | 'identify'
  | 'publish'
  | 'listen'
  | 'unlisten'
  | 'message'
  | 'post';
type HookFunction<T extends MessageHeader> = (header: T) => T;
type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT';
interface WebMQClientOptions {
  url: string;
  sessionId: string;
  reconnectDelays?: number[];
  logLevel?: LogLevel;
}

export {
  WebMQClientOptions,
  ClientMessageHeader,
  ServerMessageHeader,
  MessageHeader,
  HookName,
  HookFunction,
};

export default class WebMQClient {
  private _ws: ReconnectingWebSocket | null = null;
  private _messageListeners = new Map<
    string,
    Map<(payload: any) => void, boolean>
  >();
  private _messageQueue: { header: ClientMessageHeader; payload?: ArrayBuffer; }[] = [];
  private _hooks = {
    pre: new Set<HookFunction<MessageHeader>>(),
    identify: new Set<HookFunction<ClientMessageHeader>>(),
    publish: new Set<HookFunction<ClientMessageHeader>>(),
    listen: new Set<HookFunction<ClientMessageHeader>>(),
    unlisten: new Set<HookFunction<ClientMessageHeader>>(),
    message: new Set<HookFunction<ServerMessageHeader>>(),
    post: new Set<HookFunction<MessageHeader>>(),
  };

  // Options
  readonly url: string;
  readonly sessionId: string;
  public reconnectDelays = [0, 1000, 2000, 4000, 8000];
  public logLevel: LogLevel = 'INFO';

  constructor(options: WebMQClientOptions) {
    this.url = options.url;
    this.sessionId = options.sessionId;
    if (options.reconnectDelays) {
      this.reconnectDelays = options.reconnectDelays;
    }
    if (options.logLevel) {
      this.logLevel = options.logLevel;
    }
    this._log('DEBUG', 'WebMQClient instance created');
  }

  public connect() {
    // Clean up any existing connection before creating a new one
    if (this._ws) {
      this._ws.close(1000, 'Reconnecting');
      this._ws = null;
    }

    this._log('INFO', `WebMQClient connecting to ${this.url}`);
    this._ws = new ReconnectingWebSocket(this.url, this.reconnectDelays);
    this._ws.binaryType = 'arraybuffer';

    let identifyMessageId = uuid();
    this._ws?.addEventListener('error', (err: Event) => {
      this._log('ERROR', 'WebMQClient encountered an error', err);
    });

    this._ws?.addEventListener('close', (event) => {
      this._log('INFO', `WebMQClient connection closed`, event)
    });

    const onOpen = () => {
      this._log(
        'INFO',
        `WebMQClient connection established, sending identify with sessionId: ${this.sessionId}`
      );
      try {
        let header = this._runHooks('pre', {
          action: 'identify',
          messageId: identifyMessageId,
          sessionId: this.sessionId,
        });
        header = this._runHooks('identify', header);
        header = this._runHooks('post', header);
        this._ws?.send(bundleData(header));
        this._messageQueue.forEach(({ header, payload }) => {
          this._sendOrEnqueue(header, payload);
        });
      } catch (error) {
        this._log('error', 'Error during identify', error);
      }
    };
    this._ws?.addEventListener('open', onOpen);
    this._ws?.addEventListener('reconnected', onOpen);

    this._ws?.addEventListener('message', (event: Event) => {
      const messageEvent = event as MessageEvent;
      let header: ServerMessageHeader, payload: ArrayBuffer | undefined;
      if (!(messageEvent.data instanceof ArrayBuffer)) {
        this._log('WARNING', 'Received message in unsupported format');
        return;
      }
      try {
        [header, payload] = unbundleData(messageEvent.data);
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
        .filter((bindingKey) =>
          matchesPattern(header.routingKey!, bindingKey)
        )
        .forEach((bindingKey) => {
          this._messageListeners
            .get(bindingKey)
            ?.forEach((isJson, callback) => {
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
    });

    this._ws?.addEventListener('reconnecting', () => {
      this._log(
        'WARNING',
        'WebMQClient connection lost, attempting to reconnect'
      );
    });

    // Graceful shutdown on page unload
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', () => {
        this.disconnect();
      });
    }
  }

  public disconnect() {
    this._log('INFO', 'WebMQClient disconnecting');
    const ws = this._ws;  // Capture the reference
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Client disconnect');
    } else if (ws) {
      ws.addEventListener('open', () => ws.close(1000, 'Client disconnect'));
    }
    this._ws = null;  // Clear it so we know it's disconnected
  }

  public publish(routingKey: string, payload: ArrayBuffer | object | any[]) {
    this._log('DEBUG', `Publishing message with routingKey: ${routingKey}`);
    const actualPayload =
      payload instanceof ArrayBuffer
        ? payload
        : new TextEncoder().encode(JSON.stringify(payload)).buffer;

    this._sendOrEnqueue({ action: 'publish', routingKey }, actualPayload);
  }

  public listen(bindingKey: string, callback: (payload: any) => void, isJson: boolean = true) {
    this._log('INFO', `Adding listener for bindingKey: ${bindingKey}`);
    let callbacks = this._messageListeners.get(bindingKey);
    if (!callbacks) {
      callbacks = new Map<(payload: any) => void, boolean>();
      this._messageListeners.set(bindingKey, callbacks);
    }

    if (!callbacks.has(callback)) {
      callbacks.set(callback, isJson);
      // Only send to backend if this is the first listener for this bindingKey
      if (callbacks.size === 1) {
        this._log('INFO', `First callback for bindingKey ${bindingKey}; sending listen request`);
        this._sendOrEnqueue({ action: 'listen', bindingKey });
      }
    }
  }

  public listenRaw(bindingKey: string, callback: (payload: any) => void) {
    this.listen(bindingKey, callback, false);
  }

  public listenJson(bindingKey: string, callback: (payload: any) => void) {
    this.listen(bindingKey, callback, true);
  }

  public unlisten(
    bindingKey: string,
    callback: (payload: any) => void
  ) {
    this._log('INFO', `Removing listener for bindingKey: ${bindingKey}`);
    const callbacks = this._messageListeners.get(bindingKey);
    if (!callbacks || !callbacks.has(callback)) {
      return;
    }
    callbacks.delete(callback);
    if (callbacks.size === 0) {
      this._log('INFO', `No more callbacks for bindingKey ${bindingKey}; sending unlisten request`);
      this._messageListeners.delete(bindingKey); // Clean up empty Map
      this._sendOrEnqueue({ action: 'unlisten', bindingKey });
    }
  }

  private _sendOrEnqueue(header: ClientMessageHeader, payload?: ArrayBuffer) {
    const messageId = uuid();

    if (this._ws?.readyState === WebSocket.OPEN) {
      let actualHeader: ClientMessageHeader = { ...header, messageId };
      try {
        actualHeader = this._runHooks('pre', actualHeader);
        actualHeader = this._runHooks(header.action, actualHeader);
        actualHeader = this._runHooks('post', actualHeader);
        this._ws?.send(bundleData(actualHeader, payload));
      } catch (error) {
        this._log('error', 'Error sending message', error);
      }
    } else {
      this._messageQueue.push({ header: { ...header, messageId }, payload });
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

  private _runHooks<T extends MessageHeader>(hookName: HookName, header: T) {
    const hooks = this._hooks[hookName] as Set<HookFunction<MessageHeader>>;
    let actualHeader: MessageHeader = header;
    for (const hook of hooks) {
      actualHeader = hook(actualHeader);
      if (actualHeader === undefined) {
        throw new Error(`Hook ${hookName} did not return a header object`);
      }
    }
    return actualHeader as T;
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
}

function matchesPattern(routingKey: string, bindingKey: string): boolean {
  const regexPattern = bindingKey
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*/g, '[^.]+') // * matches one or more non-dots
    .replace(/#/g, '.*'); // # matches zero or more of any character
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(routingKey);
}
