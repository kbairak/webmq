import { EventEmitter } from 'eventemitter3';
import { v4 as uuid } from 'uuid';
import ReconnectingWebSocket from './ReconnectingWebSocket';
import { bundleData, unbundleData } from './bundle';

// TODOs:
//   - graceful shutdown
//   - logs
//   - more events for EventEmitter
//   - session management (get-or-create session ID on window.sessionStorage)
//   - ack back on message

type HeaderTransformer = (header: object) => object | Promise<object>;

export default class WebMQClient extends EventEmitter {
  private _ws: ReconnectingWebSocket | null = null;
  private _pendingMessages = new Map<string, { resolve: Function, reject: Function }>();
  private _messageListeners = new Map<string, Map<(payload: any) => void, boolean>>();
  private _identified: boolean = false;
  private _timeoutDelay: number;
  private _messageQueue: { header: object, payload?: ArrayBuffer }[] = [];
  private _hooks: {
    identify: Set<HeaderTransformer>;
    publish: Set<HeaderTransformer>;
    listen: Set<HeaderTransformer>;
    unlisten: Set<HeaderTransformer>;
    all: Set<HeaderTransformer>;
  } = {
      identify: new Set(),
      publish: new Set(),
      listen: new Set(),
      unlisten: new Set(),
      all: new Set(),
    };

  constructor({ timeoutDelay = 10000 } = {}) {
    super();
    this._timeoutDelay = timeoutDelay;
  }

  public connect(url: string, sessionId: string): Promise<void> {
    this._ws = new ReconnectingWebSocket(url);
    this._ws.binaryType = 'arraybuffer';

    let identifyMessageId = uuid();

    return new Promise((resolveConnect, rejectConnect) => {
      const onError = (err: Event) => {
        rejectConnect();
        this.emit('error', err);
      };
      this._ws?.addEventListener('error', onError);

      const onClose = (event: Event) => {
        rejectConnect();
        this._onClose(event);
      }
      this._ws?.addEventListener('close', onClose);

      this._ws?.addEventListener('message', (event: Event) => {
        const messageEvent = event as MessageEvent;
        let header: any, payload: ArrayBuffer | undefined;
        if (messageEvent.data instanceof ArrayBuffer) {
          [header, payload] = unbundleData(messageEvent.data);
        } else {
          this.emit('error', new Error('Unsupported message format'));
          return;
        }

        if (header.action === 'ack') {
          if (header.messageId === identifyMessageId) {
            this._ws?.addEventListener('close', this._onClose);
            this._ws?.removeEventListener('close', onClose);
            this._identified = true;

            (async () => {
              for (const { header, payload } of this._messageQueue) {
                const headerWithAction = header as { action: string;[key: string]: any };
                let transformedHeader = header;

                // Run action-specific hooks
                const action = headerWithAction.action;
                if (action === 'identify' || action === 'publish' || action === 'listen' || action === 'unlisten') {
                  for (const hook of this._hooks[action]) {
                    transformedHeader = await hook(transformedHeader);
                  }
                }

                // Run 'all' hooks
                for (const hook of this._hooks.all) {
                  transformedHeader = await hook(transformedHeader);
                }

                this._ws?.send(bundleData(transformedHeader, payload));
              }
              this._messageQueue.length = 0; // Clear the queue
            })();

            resolveConnect();
          } else if (this._pendingMessages.has(header.messageId)) {
            this._pendingMessages.get(header.messageId)?.resolve();
            this._pendingMessages.delete(header.messageId);
          } else {
            this.emit('error', new Error(`Received ack for unknown messageId: ${header.messageId}`));
          }
        } else if (header.action === 'nack') {
          if (this._pendingMessages.has(header.messageId)) {
            this._pendingMessages.get(header.messageId)?.reject();
            this._pendingMessages.delete(header.messageId);
          }
        } else if (header.action === 'message') {
          [...this._messageListeners.keys()]
            .filter((bindingKey) => matchesPattern(header.routingKey, bindingKey))
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
      });

      this._ws?.addEventListener('open', async () => {
        let header: object = { action: 'identify', messageId: identifyMessageId, sessionId };
        for (const hook of this._hooks.identify) {
          header = await hook(header);
        }
        for (const hook of this._hooks.all) {
          header = await hook(header);
        }
        this._ws?.send(bundleData(header));
      });

      this._ws?.addEventListener('reconnecting', () => { this._identified = false; })
      this._ws?.addEventListener('reconnected', async () => {
        identifyMessageId = uuid();
        let header: object = { action: 'identify', messageId: identifyMessageId, sessionId };
        for (const hook of this._hooks.identify) {
          header = await hook(header);
        }
        for (const hook of this._hooks.all) {
          header = await hook(header);
        }
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

  public async listen(
    bindingKey: string, callback: (payload: any) => void, isJson: boolean = true
  ): Promise<void> {
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
    this.emit('close', event);
  };

  private _sendWithAck(header: object, payload?: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const messageId = uuid();
      const timeout = setTimeout(() => {
        this._pendingMessages.delete(messageId);
        reject(new Error('Message timeout'));
      }, this._timeoutDelay);

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
        (async () => {
          const headerWithAction = header as { action: string;[key: string]: any };
          let transformedHeader: object = { ...header, messageId };
          const action = headerWithAction.action;
          if (action === 'identify' || action === 'publish' || action === 'listen' || action === 'unlisten') {
            for (const hook of this._hooks[action]) {
              transformedHeader = await hook(transformedHeader);
            }
          }
          for (const hook of this._hooks.all) {
            transformedHeader = await hook(transformedHeader);
          }
          this._ws?.send(bundleData(transformedHeader, payload));
        })();
      } else {
        this._messageQueue.push({ header: { ...header, messageId }, payload });
      }
    });
  }

  public addHook(action: keyof typeof this._hooks, hook: HeaderTransformer): void {
    this._hooks[action].add(hook);
  }

  public removeHook(action: keyof typeof this._hooks, hook: HeaderTransformer): void {
    this._hooks[action].delete(hook);
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
