export type Action =
  | 'identify'
  | 'publish'
  | 'listen'
  | 'unlisten'
  | 'ping'
  | 'pong'
  | 'ack'
  | 'nack'
  | 'message';

export interface ClientMessageHeader {
  action: Action;
  messageId?: string;
  sessionId?: string;
  routingKey?: string;
  bindingKey?: string;
  rmqOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ServerMessageHeader {
  action?: Action;
  messageId?: string;
  routingKey?: string;
  [key: string]: unknown;
}

export type MessageHeader = ClientMessageHeader | ServerMessageHeader;
