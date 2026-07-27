import { v4 as uuid } from 'uuid';
import './platform';
import ReconnectingWebSocket from './ReconnectingWebSocket';
import { EventTarget, CustomEvent, onReconnectSignal, onUnload } from './platform';
import {
  bundleData,
  unbundleData,
  type ClientMessageHeader,
  type ServerMessageHeader,
  type MessageHeader,
  makePing,
  makeAck,
  isPong,
  isAck,
  isNack,
} from 'webmq-protocol';

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
  pingInterval?: number;
  pongTimeout?: number;
  ackTimeout?: number;
}

export {
  WebMQClientOptions,
  ClientMessageHeader,
  ServerMessageHeader,
  MessageHeader,
  HookName,
  HookFunction,
};

export default class WebMQClient extends EventTarget {
  private _ws: ReconnectingWebSocket | null = null;
  private _messageListeners = new Map<
    string,
    Map<(payload: any) => void, boolean>
  >();
  private _messageQueue: {
    header: ClientMessageHeader;
    payload?: ArrayBuffer;
    resolve?: (value: void) => void;
    reject?: (reason: any) => void;
  }[] = [];
  private _pendingAcks = new Map<
    string,
    {
      header: ClientMessageHeader;
      payload?: ArrayBuffer;
      resolve: (value: void) => void;
      reject: (reason: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private _lastPongAt = 0;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectCount = 0;
  private _reconnectSignalCleanup: (() => void) | null = null;
  private _unloadCleanup: (() => void) | null = null;
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
  public reconnectDelays = [0, 500, 1000, 2000, 3000];
  public logLevel: LogLevel = 'INFO';
  public pingInterval = 5000;
  public pongTimeout = 10000;
  public ackTimeout = 5000;

  constructor(options: WebMQClientOptions) {
    super();
    this.url = options.url;
    this.sessionId = options.sessionId;
    if (options.reconnectDelays) {
      this.reconnectDelays = options.reconnectDelays;
    }
    if (options.logLevel) {
      this.logLevel = options.logLevel;
    }
    if (options.pingInterval !== undefined) {
      this.pingInterval = options.pingInterval;
    }
    if (options.pongTimeout !== undefined) {
      this.pongTimeout = options.pongTimeout;
    }
    if (options.ackTimeout !== undefined) {
      this.ackTimeout = options.ackTimeout;
    }
    this._log('DEBUG', 'WebMQClient instance created');
  }

  public connect() {
    if (this._ws) {
      this._ws.close(1000, 'Reconnecting');
      this._ws = null;
    }

    this._log('INFO', `WebMQClient connecting to ${this.url}`);
    this._ws = new ReconnectingWebSocket(this.url, this.reconnectDelays);
    this._ws.binaryType = 'arraybuffer';

    this._ws?.addEventListener('error', (err: Event) => {
      this._log('ERROR', 'WebMQClient encountered an error', err);
    });

    this._ws?.addEventListener('close', () => {
      const pendingEntries = [...this._pendingAcks.entries()];
      this._pendingAcks.clear();
      for (const [, entry] of pendingEntries) {
        clearTimeout(entry.timer);
        this._messageQueue.unshift({ header: entry.header, payload: entry.payload });
      }
      if (this._heartbeatTimer !== null) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
      this._dispatchEvent('disconnected');
    });

    this._ws?.addEventListener('reconnecting', () => {
      if (this._heartbeatTimer !== null) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
    });

    const onOpen = () => {
      if (this._reconnectCount > 0) {
        this._dispatchEvent('reconnected');
      } else {
        this._dispatchEvent('connected');
      }
      const identifyMessageId = uuid();
      try {
        let header: ClientMessageHeader = {
          action: 'identify',
          messageId: identifyMessageId,
          sessionId: this.sessionId,
        };
        header = this._runHooks('pre', header);
        header = this._runHooks('identify', header);
        header = this._runHooks('post', header);
        this._ws?.send(bundleData(header));
      } catch (error) {
        this._log('ERROR', 'Error during identify', error);
      }
      this._messageListeners.forEach((_, bindingKey) => {
        this._sendOrEnqueue({ action: 'listen', bindingKey });
      });
      const entries = [...this._messageQueue];
      this._messageQueue = [];
      for (const { header, payload, resolve, reject } of entries) {
        let actualHeader: ClientMessageHeader;
        if (!header.messageId) {
          actualHeader = { ...header, messageId: uuid() };
        } else {
          actualHeader = header;
        }
        try {
          actualHeader = this._runHooks('pre', actualHeader);
          actualHeader = this._runHooks(actualHeader.action as HookName, actualHeader);
          actualHeader = this._runHooks('post', actualHeader);
          this._ws?.send(bundleData(actualHeader, payload));
          if (resolve && reject) {
            const timer = setTimeout(() => {
              this._pendingAcks.delete(actualHeader.messageId!);
              reject(new Error('ACK timeout'));
            }, this.ackTimeout);
            this._pendingAcks.set(actualHeader.messageId!, {
              header: actualHeader,
              payload,
              resolve,
              reject,
              timer,
            });
          }
        } catch (error) {
          this._log('ERROR', 'Error sending message during queue flush', error);
          if (reject) reject(error);
        }
      }
      this._lastPongAt = Date.now();
      if (this._heartbeatTimer !== null) {
        clearInterval(this._heartbeatTimer);
      }
      this._heartbeatTimer = setInterval(() => {
        if (Date.now() - this._lastPongAt > this.pongTimeout) {
          this._log('WARNING', 'Pong timeout, force reconnecting');
          this._ws?.forceReconnect();
          return;
        }
        this._ws?.send(bundleData(makePing()));
      }, this.pingInterval);
    };

    this._ws?.addEventListener('open', () => {
      this._reconnectCount = 0;
      onOpen();
    });
    this._ws?.addEventListener('reconnected', () => {
      this._reconnectCount++;
      onOpen();
    });

    this._ws?.addEventListener('message', (event: Event) => {
      const messageEvent = event as MessageEvent;
      if (!(messageEvent.data instanceof ArrayBuffer)) {
        this._log('WARNING', 'Received message in unsupported format');
        return;
      }
      let header: ServerMessageHeader, payload: ArrayBuffer | undefined;
      try {
        [header, payload] = unbundleData(messageEvent.data);
        this._log('DEBUG', 'Received message', header);
      } catch (err) {
        this._log('WARNING', 'Failed to parse incoming message', err);
        return;
      }
      if (isPong(header)) {
        this._lastPongAt = Date.now();
        return;
      }
      if (isAck(header)) {
        const entry = this._pendingAcks.get(header.messageId!);
        if (entry) {
          clearTimeout(entry.timer);
          this._pendingAcks.delete(header.messageId!);
          entry.resolve();
        }
        return;
      }
      if (isNack(header)) {
        const entry = this._pendingAcks.get(header.messageId!);
        if (entry) {
          clearTimeout(entry.timer);
          this._pendingAcks.delete(header.messageId!);
          entry.reject(new Error(String(header.error || 'nack')));
        }
        return;
      }
      if (!header.routingKey) {
        this._log('WARNING', 'Received message without routingKey');
        return;
      }
      try {
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
        if (header.messageId) {
          this._ws?.send(bundleData(makeAck(header.messageId)));
        }
      } catch (err) {
        this._log('ERROR', 'Error dispatching message', err);
        if (header.messageId) {
          this._ws?.send(bundleData(makeAck(header.messageId)));
        }
      }
    });

    this._ws?.addEventListener('reconnecting', (event: Event) => {
      this._dispatchEvent('reconnecting', (event as any).detail);
    });

    this._reconnectSignalCleanup = onReconnectSignal(() => {
      if (this._ws && (this._ws.readyState !== WebSocket.OPEN || Date.now() - this._lastPongAt > this.pongTimeout)) {
        this._ws.forceReconnect();
      }
    });

    this._unloadCleanup = onUnload(() => {
      this.disconnect();
    });
  }

  public disconnect() {
    this._log('INFO', 'WebMQClient disconnecting');
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    const ws = this._ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Client disconnect');
    } else if (ws) {
      ws.addEventListener('open', () => ws.close(1000, 'Client disconnect'));
    }
    this._ws = null;
    if (this._reconnectSignalCleanup) {
      this._reconnectSignalCleanup();
      this._reconnectSignalCleanup = null;
    }
    if (this._unloadCleanup) {
      this._unloadCleanup();
      this._unloadCleanup = null;
    }
  }

  public forceReconnect() {
    this._ws?.forceReconnect();
  }

  public publish(routingKey: string, payload: ArrayBuffer | object | any[]): Promise<void> {
    this._log('DEBUG', `Publishing message with routingKey: ${routingKey}`);
    const actualPayload =
      payload instanceof ArrayBuffer
        ? payload
        : new TextEncoder().encode(JSON.stringify(payload)).buffer;
    return this._sendOrEnqueue({ action: 'publish', routingKey }, actualPayload);
  }

  public listen(bindingKey: string, callback: (payload: any) => void, isJson: boolean = true): Promise<void> {
    this._log('INFO', `Adding listener for bindingKey: ${bindingKey}`);
    let callbacks = this._messageListeners.get(bindingKey);
    if (!callbacks) {
      callbacks = new Map<(payload: any) => void, boolean>();
      this._messageListeners.set(bindingKey, callbacks);
    }
    if (!callbacks.has(callback)) {
      callbacks.set(callback, isJson);
      if (callbacks.size === 1) {
        this._log('INFO', `First callback for bindingKey ${bindingKey}; sending listen request`);
        return this._sendOrEnqueue({ action: 'listen', bindingKey });
      }
    }
    return Promise.resolve();
  }

  public listenRaw(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    return this.listen(bindingKey, callback, false);
  }

  public listenJson(bindingKey: string, callback: (payload: any) => void): Promise<void> {
    return this.listen(bindingKey, callback, true);
  }

  public unlisten(
    bindingKey: string,
    callback: (payload: any) => void
  ): Promise<void> {
    this._log('INFO', `Removing listener for bindingKey: ${bindingKey}`);
    const callbacks = this._messageListeners.get(bindingKey);
    if (!callbacks || !callbacks.has(callback)) {
      return Promise.resolve();
    }
    callbacks.delete(callback);
    if (callbacks.size === 0) {
      this._log('INFO', `No more callbacks for bindingKey ${bindingKey}; sending unlisten request`);
      this._messageListeners.delete(bindingKey);
      return this._sendOrEnqueue({ action: 'unlisten', bindingKey });
    }
    return Promise.resolve();
  }

  private _sendOrEnqueue(
    header: ClientMessageHeader,
    payload?: ArrayBuffer,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let actualHeader: ClientMessageHeader;
      if (!header.messageId) {
        actualHeader = { ...header, messageId: uuid() };
      } else {
        actualHeader = header;
      }
      if (this._ws?.readyState === WebSocket.OPEN) {
        try {
          actualHeader = this._runHooks('pre', actualHeader);
          actualHeader = this._runHooks(actualHeader.action as HookName, actualHeader);
          actualHeader = this._runHooks('post', actualHeader);
          this._ws?.send(bundleData(actualHeader, payload));
          const timer = setTimeout(() => {
            this._pendingAcks.delete(actualHeader.messageId!);
            reject(new Error('ACK timeout'));
          }, this.ackTimeout);
          this._pendingAcks.set(actualHeader.messageId!, {
            header: actualHeader,
            payload,
            resolve,
            reject,
            timer,
          });
        } catch (error) {
          this._log('ERROR', 'Error sending message', error);
          reject(error);
        }
      } else {
        this._messageQueue.push({
          header: actualHeader,
          payload,
          resolve,
          reject,
        });
      }
    });
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

  private _dispatchEvent(type: string, detail?: any) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
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
    .replace(/\./g, '\\.')
    .replace(/\*/g, '[^.]+')
    .replace(/#/g, '.*');
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(routingKey);
}
