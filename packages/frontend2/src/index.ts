import { v4 as uuid } from 'uuid';
import ReconnectingWebSocket from './ReconnectingWebSocket';
import { bundleData, unbundleData } from './bundle';

// TODOs:
//   - Helpers for session vs localStorage vs React Native vs vanilla JS vs React
//   - ack back on message (?)

// Types
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
type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT';
interface WebMQClientOptions {
  url: string;
  sessionId: string;
  timeoutDelay?: number;
  reconnectDelays?: number[];
  logLevel?: LogLevel;
};

export { ClientMessageHeader, ServerMessageHeader, MessageHeader, HookName, HookFunction };

export default class WebMQClient extends EventTarget {
  public logLevel: LogLevel = 'INFO';

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

  // Options
  readonly url: string;
  readonly sessionId: string;
  public timeoutDelay = 10000;
  public reconnectDelays = [0, 1000, 2000, 4000, 8000];

  constructor(options: WebMQClientOptions) {
    super();
    this.url = options.url;
    this.sessionId = options.sessionId;
    if (options.timeoutDelay) { this.timeoutDelay = options.timeoutDelay; }
    if (options.reconnectDelays) { this.reconnectDelays = options.reconnectDelays; }
    if (options.logLevel) { this.logLevel = options.logLevel; }

    // Graceful shutdown on page unload
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', () => {
        this._ws?.close();
      });
    }
  }

  public connect(): Promise<void> {
    this._log('INFO', `WebMQClient connecting to ${this.url}`);
    this._ws = new ReconnectingWebSocket(this.url, this.reconnectDelays);
    this._ws.binaryType = 'arraybuffer';

    let identifyMessageId = uuid();

    return new Promise((resolveConnect, rejectConnect) => {
      const onError = (err: Event) => {
        rejectConnect();
        this.dispatchEvent(err);
      };
      this._ws?.addEventListener('error', onError);

      const onClose = (event: Event) => {
        this._log(
          'WARNING',
          'WebMQClient connection closed before being established: '
          + `${event instanceof CloseEvent ? event.reason : 'unknown reason'}`,
        )
        rejectConnect();
        this._onClose(event);
      }
      this._ws?.addEventListener('close', onClose);

      this._ws?.addEventListener('message', async (event: Event) => {
        const messageEvent = event as MessageEvent;
        let header: ServerMessageHeader, payload: ArrayBuffer | undefined;
        if (messageEvent.data instanceof ArrayBuffer) {
          [header, payload] = unbundleData(messageEvent.data);
          this._log('DEBUG', `Received message: ${JSON.stringify(header)}`)
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

            if (this._messageQueue.length > 0) {
              this._log(
                'INFO',
                `Flushing ${this._messageQueue.length} queued messages after reconnect`,
              );
            }
            for (const { header, payload } of this._messageQueue) {
              try {
                let actualHeader = await this._runHooks('pre', header);
                actualHeader = await this._runHooks(header.action, header);
                actualHeader = await this._runHooks('post', header);
                this._ws?.send(bundleData(actualHeader, payload));
              } catch (error) {
                this.dispatchEvent(new ErrorEvent('error', { error }));
              }
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
              error: new Error('Received nack without messageId')
            }));
          } else if (this._pendingMessages.has(header.messageId)) {
            this._pendingMessages.get(header.messageId)?.reject(header.error || null);
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
        this._log(
          'INFO', 'WebMQClient connection established, sending identify'
        );
        try {
          let header = await this._runHooks('pre', {
            action: 'identify', messageId: identifyMessageId, sessionId: this.sessionId
          } as ClientMessageHeader);
          header = await this._runHooks('identify', header);
          header = await this._runHooks('post', header);
          this._ws?.send(bundleData(header));
        } catch (error) {
          this.dispatchEvent(new ErrorEvent('error', { error }));
        }
      });

      this._ws?.addEventListener('reconnecting', () => {
        this._log('WARNING', 'WebMQClient connection lost, attempting to reconnect');
        this._identified = false;
      })
      this._ws?.addEventListener('reconnected', async () => {
        this._log('INFO', 'WebMQClient reconnected, sending identify');
        identifyMessageId = uuid();
        try {
          let header = await this._runHooks('pre', {
            action: 'identify', messageId: identifyMessageId, sessionId: this.sessionId
          });
          header = await this._runHooks('identify', header);
          header = await this._runHooks('post', header);
          this._ws?.send(bundleData(header));
        } catch (error) {
          this.dispatchEvent(new ErrorEvent('error', { error }));
        }
      })
    });
  }

  public disconnect(): Promise<void> {
    this._log('INFO', 'WebMQClient disconnecting');
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
    this._log('DEBUG', `Publishing message with routingKey: ${routingKey}`);
    const actualPayload = payload instanceof ArrayBuffer
      ? payload
      : (new TextEncoder()).encode(JSON.stringify(payload)).buffer;

    await this._sendWithAck({ action: 'publish', routingKey }, actualPayload);
  }

  public async listen(
    bindingKey: string, callback: (payload: any) => void, isJson: boolean = true
  ): Promise<void> {
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
        this._log(
          'INFO', `First callback for bindingKey ${bindingKey}; sending listen request`
        );
        await this._sendWithAck({ action: 'listen', bindingKey });
      }
    }
  }

  public listenRaw(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    return this.listen(bindingKey, callback, false);
  }

  public listenJson(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    return this.listen(bindingKey, callback, true);
  }

  public async unlisten(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    this._log('INFO', `Removing listener for bindingKey: ${bindingKey}`);
    const callbacks = this._messageListeners.get(bindingKey);
    if (!callbacks || !callbacks.has(callback)) {
      return;
    }
    callbacks.delete(callback);
    if (callbacks.size === 0) {
      this._log(
        'INFO', `No more callbacks for bindingKey ${bindingKey}; sending unlisten request`
      )
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
        try {
          actualHeader = await this._runHooks('pre', actualHeader);
          actualHeader = await this._runHooks(header.action, actualHeader);
          actualHeader = await this._runHooks('post', actualHeader);
          this._ws?.send(bundleData(actualHeader, payload));
        } catch (error) {
          this.dispatchEvent(new ErrorEvent('error', { error }));
        }
      } else {
        this._messageQueue.push({ header: { ...header, messageId }, payload });
      }
    });
  }

  public addHook(action: 'pre' | 'post', hook: HookFunction<MessageHeader>): void;
  public addHook(action: 'identify' | 'publish' | 'listen' | 'unlisten', hook: HookFunction<ClientMessageHeader>): void;
  public addHook(action: 'message', hook: HookFunction<ServerMessageHeader>): void;
  public addHook(action: HookName, hook: HookFunction<any>): void {
    this._log('INFO', `Adding hook for action: ${action}`);
    this._hooks[action].add(hook);
  }

  public removeHook(action: 'pre' | 'post', hook: HookFunction<MessageHeader>): void;
  public removeHook(action: 'identify' | 'publish' | 'listen' | 'unlisten', hook: HookFunction<ClientMessageHeader>): void;
  public removeHook(action: 'message', hook: HookFunction<ServerMessageHeader>): void;
  public removeHook(action: HookName, hook: HookFunction<any>): void {
    this._log('INFO', `Removing hook for action: ${action}`);
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

  private _log(logLevel: string, message: string) {
    const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'SILENT']
    const instanceLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(logLevel);
    if (messageLevelIndex >= instanceLevelIndex) {
      this.dispatchEvent(new CustomEvent('log', { detail: { logLevel, message } }));
    }
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
