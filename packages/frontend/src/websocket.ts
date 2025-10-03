import { v4 as uuid } from 'uuid';

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

  private _pendingMessages = new Map<string, { data: any; resolve: Function; reject: Function; timeout: any }>();
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


  constructor(readonly url: string) {
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

      const timeout = setTimeout(() => {
        this._pendingMessages.delete(messageId);
        reject(new Error('Message timeout'));
      }, this.timeoutDelay);

      this._pendingMessages.set(messageId, {
        data: { ...data, messageId: messageId },
        resolve,
        reject,
        timeout
      });

      try {
        // Ensure connection is established
        await this._ensureConnection();

        // Wait for identification if this is not an identify message
        if (data.action !== 'identify' && this._identifyPromise) {
          await this._identifyPromise;
        }

        this._flushPendingMessages();
      } catch (error) {
        reject(error);
      }
    });
  }

  // Lazy connection - only connects when needed
  private _ensureConnection(): Promise<void> {
    if (!this._connectionPromise) {
      this._connectionPromise = new Promise((resolve, reject) => {
        this._ws = new WebSocket(this.url);

        this._ws.addEventListener('open', (event) => {
          const wasReconnection = this._reconnectAttempts > 0;
          this._reconnectAttempts = 0;

          this._cachedError = null;
          this._cachedClose = null;

          this._eventListeners.open.forEach(listener => listener(event));

          resolve();

          // Send identify message FIRST to establish session with backend
          const identifyMessage = { action: 'identify', sessionId: this.sessionId, messageId: uuid() };
          this._identifyMessageId = identifyMessage.messageId;

          this._pendingMessages.set(identifyMessage.messageId, {
            data: identifyMessage,
            resolve: () => { },
            reject: () => { },
            timeout: setTimeout(() => {
              this._pendingMessages.delete(identifyMessage.messageId);
              this._identifyPromise = null;
              this._identifyMessageId = null;
            }, this.timeoutDelay)
          });

          this._identifyPromise = new Promise<void>((resolveIdentify, rejectIdentify) => {
            const pending = this._pendingMessages.get(identifyMessage.messageId);
            if (pending) {
              pending.resolve = resolveIdentify;
              pending.reject = rejectIdentify;
            }
          });

          // Send identify message directly
          this._ws!.send(JSON.stringify(identifyMessage));

          // Flush OTHER pending messages (excluding identify messages)
          this._flushPendingMessagesExceptIdentify();
        });

        this._ws.addEventListener('message', (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (e) {
            message = { action: '' };
          }
          if (!['ack', 'nack'].includes(message.action)) {
            this._eventListeners.message.forEach(listener => listener(event));
          } else {
            const pending = this._pendingMessages.get(message.messageId);

            if (pending) {
              clearTimeout(pending.timeout);
              this._pendingMessages.delete(message.messageId);

              if (message.action === 'ack') {
                pending.resolve();
              } else {
                pending.reject(new Error(message.error || 'Message rejected'));
              }
            }
          }
        });

        this._ws.addEventListener('close', (event) => {
          this._ws = null;
          this._connectionPromise = null; // Reset so new connections can be attempted
          this._identifyPromise = null; // Reset identify promise on disconnect
          this._identifyMessageId = null; // Reset identify message ID

          // Cache first close only, don't emit immediately
          if (!this._cachedClose) {
            this._cachedClose = event;
          }

          if (this._shouldReconnect) {
            this._attemptReconnect();
          }

          reject(); // Always call - ignored if promise already resolved
        });

        this._ws.addEventListener('error', (event) => {
          // Cache first error only, don't emit immediately
          if (!this._cachedError) {
            this._cachedError = event;
          }

          console.debug('WebSocket connection attempt failed:', event);

          // Let the close event handle the disconnection logic
        });
      });
    }

    return this._connectionPromise;
  }

  private _flushPendingMessages(): void {
    for (const pending of this._pendingMessages.values()) {
      this._ws!.send(JSON.stringify(pending.data));
    }
  }

  private _flushPendingMessagesExceptIdentify(): void {
    for (const [messageId, pending] of this._pendingMessages.entries()) {
      // Skip identify messages to avoid sending them twice
      if (pending.data.action !== 'identify') {
        this._ws!.send(JSON.stringify(pending.data));
      }
    }
  }

  private async _attemptReconnect(): Promise<void> {
    this._reconnectAttempts += 1;
    this._eventListeners.reconnecting.forEach(listener => listener({ attempt: this._reconnectAttempts }));
    try {
      await this._ensureConnection();
    } catch (error) {
      if (this._reconnectAttempts >= this.maxReconnectAttempts) {
        if (this._cachedError) {
          this._eventListeners.error.forEach(listener => listener(this._cachedError));
          this._cachedError = null;
        }
        if (this._cachedClose) {
          this._eventListeners.close.forEach(listener => listener(this._cachedClose));
          this._cachedClose = null;
        }

        return;
      }

      const delay = Math.min(this.reconnectDelay * Math.pow(2, this._reconnectAttempts - 1), 30000);
      setTimeout(() => this._attemptReconnect(), delay);
    }
  }

  close(code?: number, reason?: string): void {
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
    for (const pending of this._pendingMessages.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this._pendingMessages.clear();
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
