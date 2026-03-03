import { v4 as uuid } from 'uuid';
import ReconnectingWebSocket from './ReconnectingWebSocket';
import { bundleData, unbundleData } from './bundle';

// TODOs:
//   - task queue
//   - do something with nack error
//   - more emits
//   - logs (no, in favor of emits)
//   - ack back on message (?)
//   - Helpers for session vs localStorage vs React Native vs vanilla JS vs React
//   - Configure reconnection retry attempts

// Types
interface WebMQClientOptions {
  url: string;
  sessionId: string;
  timeoutDelay?: number;
};
interface ClientMessageHeader {
  action: 'identify' | 'publish' | 'listen' | 'unlisten';
  messageId?: string;
  routingKey?: string;
  bindingKey?: string;
  [key: string]: any;
};
interface ServerMessageHeader {
  action: 'ack' | 'nack' | 'message';
  messageId?: string;
  routingKey?: string;
  [key: string]: any;
};
type MessageHeader = ClientMessageHeader | ServerMessageHeader;

type HookName = 'pre' | 'identify' | 'publish' | 'listen' | 'unlisten' | 'message' | 'post';
type HookFunction<T extends MessageHeader> = (header: T) => Promise<T>;

export { ClientMessageHeader, ServerMessageHeader, MessageHeader, HookName, HookFunction };

export default class WebMQClient extends EventTarget {
  public timeoutDelay = 10000;
  readonly url: string;
  readonly sessionId: string;

  private _queue = Promise.resolve();
  private _ws: ReconnectingWebSocket | null = null;
  private _pendingMessages = new Map<string, { resolve: Function, reject: Function }>();
  private _messageListeners = new Map<string, Map<(payload: any) => void, boolean>>();
  private _identified: boolean = false;
  private _messageQueue: { header: ClientMessageHeader, payload?: ArrayBuffer }[] = [];
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
    super();
    this.url = options.url;
    this.sessionId = options.sessionId;
    if (options.timeoutDelay) { this.timeoutDelay = options.timeoutDelay; }

    // Graceful shutdown on page unload
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', () => {
        this._ws?.close();
      });
    }
  }

  public connect(): Promise<void> {
    this._ws = new ReconnectingWebSocket(this.url);
    this._ws.binaryType = 'arraybuffer';

    let identifyMessageId = uuid();

    return new Promise((resolveConnect, rejectConnect) => {
      const onError = (err: Event) => {
        rejectConnect();
        this.dispatchEvent(err);
      };
      this._ws?.addEventListener('error', onError);

      const onClose = (event: Event) => {
        rejectConnect();
        this._onClose(event);
      }
      this._ws?.addEventListener('close', onClose);

      this._ws?.addEventListener('message', async (event: Event) => {
        const messageEvent = event as MessageEvent;
        let header: ServerMessageHeader, payload: ArrayBuffer | undefined;
        if (messageEvent.data instanceof ArrayBuffer) {
          [header, payload] = unbundleData(messageEvent.data);
        } else {
          this.dispatchEvent(new ErrorEvent('error', {
            error: new Error('Unsupported message format')
          }));
          return;
        }

        if (header.action === 'ack') {
          if (!header.messageId) {
            this.dispatchEvent(new ErrorEvent('error', {
              error: new Error('Received ack without messageId')
            }));
          } else if (header.messageId === identifyMessageId) {
            this._ws?.addEventListener('close', this._onClose);
            this._ws?.removeEventListener('close', onClose);
            this._identified = true;

            for (const { header, payload } of this._messageQueue) {
              let actualHeader = await this._runHooks('pre', header);
              actualHeader = await this._runHooks(header.action, header);
              actualHeader = await this._runHooks('post', header);

              this._ws?.send(bundleData(actualHeader, payload));
            }
            this._messageQueue.length = 0; // Clear the queue

            resolveConnect();
          } else if (this._pendingMessages.has(header.messageId)) {
            this._pendingMessages.get(header.messageId)?.resolve();
            this._pendingMessages.delete(header.messageId);
          } else {
            this.dispatchEvent(new ErrorEvent('error', {
              error: new Error(`Received ack for unknown messageId: ${header.messageId}`)
            }));
          }
        } else if (header.action === 'nack') {
          if (!header.messageId) {
            this.dispatchEvent(new ErrorEvent('error', {
              error: new Error('Received ack without messageId')
            }));
          } else if (this._pendingMessages.has(header.messageId)) {
            this._pendingMessages.get(header.messageId)?.reject();
            this._pendingMessages.delete(header.messageId);
          }
        } else if (header.action === 'message') {
          if (!header.routingKey) {
            this.dispatchEvent(new ErrorEvent('error', {
              error: new Error('Received message without routingKey')
            }));
          } else {
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
                    callback(payload)
                  }
                });
              })
          }
        }
      });

      this._ws?.addEventListener('open', async () => {
        let header = await this._runHooks('pre', {
          action: 'identify', messageId: identifyMessageId, sessionId: this.sessionId
        } as ClientMessageHeader);
        header = await this._runHooks('identify', header);
        header = await this._runHooks('post', header);
        this._ws?.send(bundleData(header));
      });

      this._ws?.addEventListener('reconnecting', () => { this._identified = false; })
      this._ws?.addEventListener('reconnected', async () => {
        identifyMessageId = uuid();
        let header = await this._runHooks('pre', {
          action: 'identify', messageId: identifyMessageId, sessionId: this.sessionId
        });
        header = await this._runHooks('identify', header);
        header = await this._runHooks('post', header);
        this._ws?.send(bundleData(header));
      })
    });
  }

  public disconnect(): Promise<void> {
    return new Promise((resolve) => {
      const onClose = (event: Event) => {
        this._ws?.removeEventListener('close', onClose);
        this._onClose(event);
        resolve();
      };
      this._ws?.addEventListener('close', onClose);
      this._ws?.removeEventListener('close', this._onClose);
      this._ws?.close();
    });
  }

  public async publish(routingKey: string, payload: ArrayBuffer | object | any[]): Promise<void> {
    const actualPayload = payload instanceof ArrayBuffer
      ? payload
      : (new TextEncoder()).encode(JSON.stringify(payload)).buffer;

    await this._sendWithAck({ action: 'publish', routingKey }, actualPayload);
  }

  public listen(
    bindingKey: string, callback: (payload: any) => void, isJson: boolean = true
  ): Promise<void> {
    return this._queue = this._queue.then(async () => {
      let callbacks = this._messageListeners.get(bindingKey);
      if (!callbacks) {
        callbacks = new Map<(payload: any) => void, boolean>();
        this._messageListeners.set(bindingKey, callbacks);
      }

      if (!callbacks.has(callback)) {
        callbacks.set(callback, isJson);
        // Only send to backend if this is the first listener for this bindingKey
        if (callbacks.size === 1) {
          await this._sendWithAck({ action: 'listen', bindingKey });
        }
      }
    });
    return this._queue;
  }

  public listenRaw(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    return this.listen(bindingKey, callback, false);
  }

  public listenJson(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    return this.listen(bindingKey, callback, true);
  }

  public async unlisten(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    const callbacks = this._messageListeners.get(bindingKey);
    if (!callbacks || !callbacks.has(callback)) {
      return;
    }
    callbacks.delete(callback);
    if (callbacks.size === 0) {
      this._messageListeners.delete(bindingKey);  // Clean up empty Map
      await this._sendWithAck({ action: 'unlisten', bindingKey });
    }
  }

  private _onClose = (event: Event) => {
    this._pendingMessages.forEach(({ reject }) => reject(new Error('Connection closed')));
    this._pendingMessages.clear();
    this.dispatchEvent(event);
  };

  private _sendWithAck(header: ClientMessageHeader, payload?: ArrayBuffer): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const messageId = uuid();
      const timeout = setTimeout(() => {
        this._pendingMessages.delete(messageId);
        reject(new Error('Message timeout'));
      }, this.timeoutDelay);

      this._pendingMessages.set(messageId, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err?: Error) => {
          clearTimeout(timeout);
          reject(err || new Error('Message rejected'));
        },
      });

      if (this._identified) {
        let actualHeader: ClientMessageHeader = { ...header, messageId };
        actualHeader = await this._runHooks('pre', actualHeader);
        actualHeader = await this._runHooks(header.action, actualHeader);
        actualHeader = await this._runHooks('post', actualHeader);
        this._ws?.send(bundleData(actualHeader, payload));
      } else {
        this._messageQueue.push({ header: { ...header, messageId }, payload });
      }
    });
  }

  public addHook(action: 'pre' | 'post', hook: HookFunction<MessageHeader>): void;
  public addHook(action: 'identify' | 'publish' | 'listen' | 'unlisten', hook: HookFunction<ClientMessageHeader>): void;
  public addHook(action: 'message', hook: HookFunction<ServerMessageHeader>): void;
  public addHook(action: HookName, hook: HookFunction<any>): void {
    this._hooks[action].add(hook);
  }

  public removeHook(action: 'pre' | 'post', hook: HookFunction<MessageHeader>): void;
  public removeHook(action: 'identify' | 'publish' | 'listen' | 'unlisten', hook: HookFunction<ClientMessageHeader>): void;
  public removeHook(action: 'message', hook: HookFunction<ServerMessageHeader>): void;
  public removeHook(action: HookName, hook: HookFunction<any>): void {
    this._hooks[action].delete(hook);
  }

  private async _runHooks<T extends MessageHeader>(hookName: HookName, header: T): Promise<T> {
    const hooks = this._hooks[hookName] as Set<HookFunction<MessageHeader>>;
    let actualHeader: MessageHeader = header;
    for (const hook of hooks) {
      actualHeader = await hook(actualHeader);
      if (actualHeader === undefined) {
        throw new Error(`Hook ${hookName} did not return a header object`);
      }
    }
    return actualHeader as T;
  }
}

function matchesPattern(routingKey: string, bindingKey: string): boolean {
  const regexPattern = bindingKey
    .replace(/\./g, '\\.') // Escape dots
    .replace(/\*/g, '[^.]+') // * matches one or more non-dots
    .replace(/#/g, '.*');    // # matches zero or more of any character
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(routingKey);
}
