/**
 * Shared logger implementation for WebMQ packages
 *
 * This file is copied to both backend and frontend packages during build.
 * Source of truth: /common/logger.ts
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface LoggerInterface {
  error(...args: any[]): void;
  warn(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
  setLogLevel(level: LogLevel): void;
  getLogLevel(): LogLevel;
}

/**
 * Logger class that can be configured with different log levels
 *
 * Usage:
 * ```typescript
 * const logger = new Logger('debug');
 * logger.info('Starting server...');
 * logger.setLogLevel('silent');
 * ```
 */
export class Logger implements LoggerInterface {
  private currentLevel: LogLevel;
  private readonly prefix: string;

  constructor(initialLevel: LogLevel = 'error', prefix: string = '') {
    this.currentLevel = initialLevel;
    this.prefix = prefix ? `[${prefix}] ` : '';
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
    const currentIndex = levels.indexOf(this.currentLevel);
    const messageIndex = levels.indexOf(level);

    return (
      currentIndex !== 0 && messageIndex <= currentIndex && messageIndex > 0
    );
  }

  private formatMessage(...args: any[]): any[] {
    if (this.prefix && args.length > 0) {
      // If first argument is a string, prepend prefix
      if (typeof args[0] === 'string') {
        return [this.prefix + args[0], ...args.slice(1)];
      } else {
        return [this.prefix, ...args];
      }
    }
    return args;
  }

  error(...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(...this.formatMessage(...args));
    }
  }

  warn(...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(...this.formatMessage(...args));
    }
  }

  info(...args: any[]): void {
    if (this.shouldLog('info')) {
      console.log(...this.formatMessage(...args));
    }
  }

  debug(...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.log(...this.formatMessage(...args));
    }
  }

  setLogLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  getLogLevel(): LogLevel {
    return this.currentLevel;
  }

  /**
   * Create a child logger with a specific prefix
   */
  child(prefix: string): Logger {
    const childPrefix = this.prefix
      ? `${this.prefix.slice(1, -2)}:${prefix}`
      : prefix;
    const childLogger = new Logger(this.currentLevel, childPrefix);
    return childLogger;
  }
}
