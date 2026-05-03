/**
 * Simple event emitter with on/off/emit interface.
 * Much simpler than EventTarget and works everywhere.
 */
export default class EventEmitter {
  private _listeners: Map<string, Set<Function>> = new Map();

  on(event: string, listener: Function): void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(listener);
  }

  off(event: string, listener: Function): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  emit(event: string, ...args: any[]): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(...args);
        } catch (error) {
          console.error(`Error in event listener for '${event}':`, error);
        }
      });
    }
  }
}
