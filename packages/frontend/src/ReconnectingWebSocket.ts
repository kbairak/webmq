import EventEmitter from './EventEmitter';

export default class ReconnectingWebSocket extends EventEmitter {
  private _ws: WebSocket | null = null;
  private _reconnectAttempts = 0;
  private _shouldReconnect = true;

  constructor(
    readonly url: string,
    private reconnectDelays = [0, 1000, 2000, 4000, 8000]
  ) {
    super();
    this._connect();
  }

  private _connect(): void {
    this._ws = new WebSocket(this.url);

    this._ws.addEventListener('open', () => {
      if (this._reconnectAttempts > 0) {
        this._reconnectAttempts = 0;
        this.emit('reconnected');
      } else {
        this.emit('open');
      }
    });

    this._ws.addEventListener('close', async (event: CloseEvent) => {
      if (
        !this._shouldReconnect ||
        this._reconnectAttempts >= this.reconnectDelays.length
      ) {
        this.emit('close', event.code, event.reason, event.wasClean);
      } else {
        if (this._reconnectAttempts === 0) {
          this.emit('reconnecting');
        }
        await new Promise((resolve) =>
          setTimeout(resolve, this.reconnectDelays[this._reconnectAttempts])
        );
        this._connect();
        this._reconnectAttempts++;
      }
    });

    this._ws.addEventListener('error', (event: Event) => {
      this.emit('error', event);
    });
    this._ws.addEventListener('message', (event: MessageEvent) => {
      this.emit('message', event.data);
    });
  }

  public send(data: any) {
    this._ws?.send(data);
  }

  public close(code?: number, reason?: string): void {
    this._shouldReconnect = false;
    this._ws?.close(code, reason);
  }

  public get binaryType(): BinaryType {
    return this._ws?.binaryType ?? 'arraybuffer';
  }
  public set binaryType(value: BinaryType) {
    this._ws!.binaryType = value;
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
