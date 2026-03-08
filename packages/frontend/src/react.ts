import { useEffect, useMemo } from 'react';
import WebMQClient from './index';
import type { WebMQClientOptions } from './index';

// Re-export core class and types
export { default as WebMQClient } from './index';
export type { WebMQClientOptions } from './index';

/**
 * React hook for managing a WebMQ client lifecycle.
 *
 * @example
 * ```tsx
 * const options = useMemo(() => ({
 *   url: 'ws://localhost:8080',
 *   sessionId: crypto.randomUUID(),
 * }), []);
 *
 * const on = useCallback((c) =>
 *   c.listen('topic', callback), [callback]);
 *
 * const off = useCallback((c) =>
 *   c.unlisten('topic', callback), [callback]);
 *
 * const client = useWebMQ(options, on, off);
 * ```
 */
export function useWebMQ(
  options: WebMQClientOptions,
  on: (c: WebMQClient) => Promise<void>,
  off: (c: WebMQClient) => Promise<void>,
) {
  const c = useMemo(() => new WebMQClient(options), [options]);

  useEffect(() => {
    const p = c.connect().then(() => on(c));
    return () => {
      p.then(() => off(c)).then(() => c.disconnect());
    };
  }, [c, on, off]);

  return c;
}
