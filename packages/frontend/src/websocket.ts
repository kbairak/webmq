import { v4 as uuid } from 'uuid';
import { HookFunction, runWithHooks } from './hooks';

/**
 * A WebSocket wrapper that provides connection management, message acknowledgments,
 * automatic reconnection, and session persistence for WebMQ communication.
 *
 * Features:
 * - WebSocket-compatible API for easy integration
 * - Lazy connection (connects only when needed)
 * - Automatic message acknowledgments with timeout handling
 * - Exponential backoff reconnection with configurable retry limits
 * - Session ID management with sessionStorage persistence
 * - Automatic identify message sending for session establishment
 * - Message queuing during connection/reconnection
 *
 * @example
 * ```typescript
 * const ws = new WebMQClientWebSocket('ws://localhost:8080');
 *
 * // Send messages with automatic ack handling
 * await ws.send({ action: 'publish', routingKey: 'test', payload: data });
 *
 * // Listen for incoming messages
 * ws.addEventListener('message', (event) => {
 *   const message = JSON.parse(event.data);
 *   if (message.action === 'message') {
 *     console.log('Received:', message.payload);
 *   }
 * });
 * ```
 */
export default class WebMQClientWebSocket {
  private _ws: WebSocket | null = null;
  private _connectionPromise: Promise<void> | null = null;
  private _identifyPromise: Promise<void> | null = null;
  readonly sessionId: string;

  private _reconnectAttempts = 0;
  public maxReconnectAttempts = 5;
  public reconnectDelay = 1000;
  public timeoutDelay = 5000;

  private _pendingMessages = new Map<string, { data: any; resolve: Function; reject: Function; timeout: any; sent: boolean }>();
  private _shouldReconnect = true;
  private _cachedError: Event | null = null;
  private _cachedClose: Event | null = null;
  private _identifyMessageId: string | null = null;
  private _eventListeners = {
    open: new Set<Function>(),
    close: new Set<Function>(),
    error: new Set<Function>(),
    message: new Set<Function>(),
    reconnecting: new Set<Function>(),
  };


  constructor(
    readonly url: string,
    public logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug' = 'info',
    private context: any = {},
    private identifyHooks: HookFunction[] = []
  ) {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      this.sessionId = sessionStorage.getItem('webmq_session_id') || '';
      if (!this.sessionId) {
        this.sessionId = uuid();
        sessionStorage.setItem('webmq_session_id', this.sessionId);
      }
    } else {
      this.sessionId = uuid();
    }
  }

  // Enhanced send with acknowledgment support
  send(data: any): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const messageId = uuid();
      this._log('debug', `send() called: action=${data.action}, messageId=${messageId}`);

      const timeout = setTimeout(() => {
        this._log('warn', `Message timeout: action=${data.action}, messageId=${messageId}`);
        this._pendingMessages.delete(messageId);
        reject(new Error('Message timeout'));
      }, this.timeoutDelay);

      this._pendingMessages.set(messageId, {
        data: { ...data, messageId: messageId },
        resolve,
        reject,
        timeout,
        sent: false
      });
      this._log('debug', `Message queued as pending: messageId=${messageId}, pendingCount=${this._pendingMessages.size}`);

      try {
        // Ensure connection is established
        await this._ensureConnection();

        // Wait for identification if this is not an identify message
        if (data.action !== 'identify' && this._identifyPromise) {
          this._log('debug', `Waiting for identify to complete before sending: messageId=${messageId}`);
          await this._identifyPromise;
          this._log('debug', `Identify complete, proceeding with send: messageId=${messageId}`);
        }

        // Send only this specific message if it hasn't been sent yet
        const pending = this._pendingMessages.get(messageId);
        if (pending && !pending.sent && this._ws) {
          this._log('debug', `Transmitting message over WebSocket: action=${data.action}, messageId=${messageId}`);
          this._ws.send(JSON.stringify(pending.data));
          pending.sent = true;
        } else if (pending?.sent) {
          this._log('debug', `Message already sent, skipping: messageId=${messageId}`);
        }
      } catch (error) {
        this._log('error', `send() failed: messageId=${messageId}, error=${error}`);
        reject(error);
      }
    });
  }

  // Lazy connection - only connects when needed
  private _ensureConnection(): Promise<void> {
    if (!this._connectionPromise) {
      this._log('info', `Establishing new WebSocket connection to ${this.url}`);
      this._log('debug', `Session ID: ${this.sessionId}`);
      this._connectionPromise = new Promise((resolve, reject) => {
        this._log('debug', `Creating new native websocket connection to ${this.url}`)
        this._ws = new WebSocket(this.url);

        this._ws.addEventListener('open', (event) => {
          const wasReconnection = this._reconnectAttempts > 0;
          this._log('info', `WebSocket connected (readyState=${this._ws?.readyState}, wasReconnection=${wasReconnection})`);
          this._reconnectAttempts = 0;

          this._cachedError = null;
          this._cachedClose = null;

          this._eventListeners.open.forEach(listener => listener(event));

          resolve();

          // Send identify message FIRST to establish session with backend
          const identifyMessage: any = { action: 'identify', sessionId: this.sessionId, messageId: uuid(), payload: {} };
          this._identifyMessageId = identifyMessage.messageId;
          this._log('debug', `Preparing identify message: sessionId=${this.sessionId}, messageId=${identifyMessage.messageId}`);

          // Run identify hooks before sending
          runWithHooks(
            this.context,
            [...this.identifyHooks, async (context, next, msg) => {
              this._log('debug', `Sending identify message with payload: ${JSON.stringify(msg.payload)}`);

              this._pendingMessages.set(msg.messageId, {
                data: msg,
                resolve: () => { },
                reject: () => { },
                timeout: setTimeout(() => {
                  this._log('warn', `Identify message timeout: messageId=${msg.messageId}`);
                  this._pendingMessages.delete(msg.messageId);
                  this._identifyPromise = null;
                  this._identifyMessageId = null;
                }, this.timeoutDelay),
                sent: false
              });

              this._identifyPromise = new Promise<void>((resolveIdentify, rejectIdentify) => {
                const pending = this._pendingMessages.get(msg.messageId);
                if (pending) {
                  pending.resolve = resolveIdentify;
                  pending.reject = rejectIdentify;
                }
              });

              // Send identify message directly
              this._ws!.send(JSON.stringify(msg));
              this._log('debug', `Identify message transmitted over WebSocket`);
              const identifyPending = this._pendingMessages.get(msg.messageId);
              if (identifyPending) {
                identifyPending.sent = true;
              }

              // Flush OTHER pending messages (excluding identify messages)
              this._flushPendingMessagesExceptIdentify();
            }],
            identifyMessage
          ).catch(error => {
            this._log('error', `Failed to send identify message: ${error.message}`);
          });
        });

        this._ws.addEventListener('message', (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (e) {
            this._log('warn', `Failed to parse incoming message: ${e}`);
            message = { action: '' };
          }
          if (!['ack', 'nack'].includes(message.action)) {
            this._log('debug', `Received data message: action=${message.action}`);
            this._eventListeners.message.forEach(listener => listener(event));
          } else {
            const pending = this._pendingMessages.get(message.messageId);

            if (pending) {
              clearTimeout(pending.timeout);
              this._pendingMessages.delete(message.messageId);

              if (message.action === 'ack') {
                this._log('debug', `Received ack: messageId=${message.messageId}, pendingCount=${this._pendingMessages.size}`);
                pending.resolve();
              } else {
                this._log('warn', `Received nack: messageId=${message.messageId}, error=${message.error}`);
                pending.reject(new Error(message.error || 'Message rejected'));
              }
            } else {
              this._log('debug', `Received ${message.action} for unknown messageId: ${message.messageId}`);
            }
          }
        });

        this._ws.addEventListener('close', (event) => {
          this._log('info', `WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`);
          this._ws = null;
          this._connectionPromise = null; // Reset so new connections can be attempted
          this._identifyPromise = null; // Reset identify promise on disconnect
          this._identifyMessageId = null; // Reset identify message ID

          // Cache first close only, don't emit immediately
          if (!this._cachedClose) {
            this._cachedClose = event;
            this._log('debug', `Cached close event for potential max retry emission`);
          }

          if (this._shouldReconnect) {
            this._log('debug', `shouldReconnect=true, will attempt reconnection`);
            this._attemptReconnect();
          } else {
            this._log('debug', `shouldReconnect=false, not reconnecting`);
          }

          reject(); // Always call - ignored if promise already resolved
        });

        this._ws.addEventListener('error', (event) => {
          this._log('error', `WebSocket error occurred`);
          // Cache first error only, don't emit immediately
          if (!this._cachedError) {
            this._cachedError = event;
            this._log('debug', `Cached error event for potential max retry emission`);
          }

          // Let the close event handle the disconnection logic
        });
      });
    } else {
      this._log('debug', `Reusing existing connection (readyState=${this._ws?.readyState})`);
    }

    return this._connectionPromise;
  }

  private _flushPendingMessages(): void {
    const pendingCount = this._pendingMessages.size;
    let sentCount = 0;
    for (const pending of this._pendingMessages.values()) {
      if (!pending.sent) {
        this._ws!.send(JSON.stringify(pending.data));
        pending.sent = true;
        sentCount++;
      }
    }
    this._log('debug', `Flushed pending messages: sent=${sentCount}, total=${pendingCount}`);
  }

  private _flushPendingMessagesExceptIdentify(): void {
    const pendingCount = this._pendingMessages.size;
    let sentCount = 0;
    for (const [messageId, pending] of this._pendingMessages.entries()) {
      // Skip identify messages and already sent messages
      if (pending.data.action !== 'identify' && !pending.sent) {
        this._ws!.send(JSON.stringify(pending.data));
        pending.sent = true;
        sentCount++;
      }
    }
    this._log('debug', `Flushed non-identify pending messages: sent=${sentCount}, total=${pendingCount}`);
  }

  private async _attemptReconnect(): Promise<void> {
    this._reconnectAttempts += 1;
    this._log('info', `Reconnection attempt ${this._reconnectAttempts}/${this.maxReconnectAttempts}`);
    this._eventListeners.reconnecting.forEach(listener => listener({ attempt: this._reconnectAttempts }));
    try {
      await this._ensureConnection();
      this._log('info', `Reconnection successful after ${this._reconnectAttempts} attempt(s)`);
    } catch (error) {
      if (this._reconnectAttempts >= this.maxReconnectAttempts) {
        this._log('error', `Max reconnection attempts (${this.maxReconnectAttempts}) reached, giving up`);
        if (this._cachedError) {
          this._log('debug', `Emitting cached error event to listeners`);
          this._eventListeners.error.forEach(listener => listener(this._cachedError));
          this._cachedError = null;
        }
        if (this._cachedClose) {
          this._log('debug', `Emitting cached close event to listeners`);
          this._eventListeners.close.forEach(listener => listener(this._cachedClose));
          this._cachedClose = null;
        }

        return;
      }

      const delay = Math.min(this.reconnectDelay * Math.pow(2, this._reconnectAttempts - 1), 30000);
      this._log('info', `Reconnection failed, retrying in ${delay}ms (attempt ${this._reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
      setTimeout(() => this._attemptReconnect(), delay);
    }
  }

  close(code?: number, reason?: string): void {
    this._log('info', `close() called: code=${code || 'default'}, reason=${reason || 'none'}`);
    this._shouldReconnect = false;
    if (this._ws) {
      this._ws.close(code, reason);
    }
    this._connectionPromise = null; // Reset connection promise
    this._identifyPromise = null; // Reset identify promise
    this._identifyMessageId = null; // Reset identify message ID

    // Clear cached events when explicitly closing
    this._cachedError = null;
    this._cachedClose = null;

    // Reject all pending messages
    const pendingCount = this._pendingMessages.size;
    for (const pending of this._pendingMessages.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this._pendingMessages.clear();
    this._log('debug', `Rejected ${pendingCount} pending message(s) due to close()`);
  }

  private _log(level: 'error' | 'warn' | 'info' | 'debug', message: string): void {
    if (this.logLevel === 'silent') return;

    const levels = ['error', 'warn', 'info', 'debug'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (messageLevelIndex <= currentLevelIndex) {
      switch (level) {
        case 'error':
          console.error(`[WebMQ WebSocket ERROR] ${message}`);
          break;
        case 'warn':
          console.warn(`[WebMQ WebSocket WARN] ${message}`);
          break;
        case 'info':
          console.log(`[WebMQ WebSocket INFO] ${message}`);
          break;
        case 'debug':
          console.debug(`[WebMQ WebSocket DEBUG] ${message}`);
          break;
      }
    }
  }

  // WebSocket-compatible properties
  get binaryType(): string { return 'blob'; }
  set binaryType(_: string) {
    throw new Error('WebMQClientWebSocket does not support changing binaryType');
  }
  get bufferedAmount(): number { return this._ws?.bufferedAmount ?? 0; }
  get extensions(): string { return this._ws?.extensions ?? ''; }
  get protocol(): string { return this._ws?.protocol ?? ''; }
  get readyState(): number { return this._ws?.readyState ?? WebSocket.CONNECTING; }

  addEventListener(type: 'open' | 'close' | 'error' | 'message' | 'reconnecting', listener: Function): void {
    this._eventListeners[type].add(listener);
  }

  removeEventListener(type: 'open' | 'close' | 'error' | 'message' | 'reconnecting', listener: Function): void {
    this._eventListeners[type].delete(listener);
  }
}
