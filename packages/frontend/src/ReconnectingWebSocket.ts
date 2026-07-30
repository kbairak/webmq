import { EventTarget, CustomEvent, type BinaryType } from './platform';
import { Event as PolyfillEvent, CloseEvent as PolyfillCloseEvent, MessageEvent as PolyfillMessageEvent } from './platform';

export default class ReconnectingWebSocket extends EventTarget {
  private _ws: WebSocket | null = null;
  private _reconnectAttempts = 0;
  private _shouldReconnect = true;
  private _desiredBinaryType: BinaryType = 'blob';
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly url: string,
    private reconnectDelays = [0, 500, 1000, 2000, 3000]
  ) {
    super();
    this._connect();
  }

  private _connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = this._desiredBinaryType;
    this._ws = ws;

    ws.addEventListener('open', () => {
      if (this._reconnectAttempts > 0) {
        this._reconnectAttempts = 0;
        this.dispatchEvent(new PolyfillEvent('reconnected'));
      } else {
        this.dispatchEvent(new PolyfillEvent('open'));
      }
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      if (ws !== this._ws) return;
      if (!this._shouldReconnect) {
        this.dispatchEvent(
          new PolyfillCloseEvent(event.type, {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          })
        );
      } else {
        this.dispatchEvent(
          new CustomEvent('reconnecting', {
            detail: { attempt: this._reconnectAttempts + 1 },
          })
        );
        const delay = this.reconnectDelays[
          Math.min(this._reconnectAttempts, this.reconnectDelays.length - 1)
        ];
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          if (this._shouldReconnect) {
            this._reconnectAttempts++;
            this._connect();
          }
        }, delay);
      }
    });

    ws.addEventListener('error', (event: Event) => {
      if (ws !== this._ws) return;
      this.dispatchEvent(
        new PolyfillEvent(event.type, {
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          composed: event.composed,
        })
      );
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      if (ws !== this._ws) return;
      this.dispatchEvent(
        new PolyfillMessageEvent(event.type, {
          data: event.data,
          origin: event.origin,
          lastEventId: event.lastEventId,
          source: event.source,
          ports: event.ports ? [...event.ports] : [],
        })
      );
    });
  }

  public send(data: any) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(data);
    }
  }

  public close(code?: number, reason?: string): void {
    this._shouldReconnect = false;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._ws?.close(code, reason);
  }

  public forceReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._reconnectAttempts = 0;
      this._connect();
      return;
    }
    this._reconnectAttempts = 0;
    this._connect();
  }

  public get binaryType(): BinaryType {
    return this._desiredBinaryType;
  }
  public set binaryType(value: BinaryType) {
    this._desiredBinaryType = value;
    if (this._ws) {
      this._ws.binaryType = value;
    }
  }
  public get bufferedAmount(): number {
    return this._ws?.bufferedAmount ?? 0;
  }
  public get extensions(): string {
    return this._ws?.extensions ?? '';
  }
  public get protocol(): string {
    return this._ws?.protocol ?? '';
  }
  public get readyState(): number {
    return this._ws?.readyState ?? WebSocket.CLOSED;
  }
}
