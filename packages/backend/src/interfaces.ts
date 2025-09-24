import WebSocket from 'ws';
import { EventEmitter } from 'events';

// --- Type Definitions ---

/** A WebSocket connection with a unique ID. */
export interface WebSocketConnectionContext {
  ws: WebSocket;
  id: string;
  [key: string]: any; // For user data from hooks
}

// --- Message Interfaces ---

// Client sends this when publishing data to a routing key
export interface PublishMessage {
  action: 'publish';
  routingKey: string;
  payload: any;
  messageId?: string;
}

// Client sends this to start listening to messages matching a binding pattern
export interface ListenMessage {
  action: 'listen';
  bindingKey: string;
}

// Client sends this to stop listening to a previously subscribed binding pattern
export interface UnlistenMessage {
  action: 'unlisten';
  bindingKey: string;
}

// Client sends this to identify itself for persistent sessions
export interface IdentifyMessage {
  action: 'identify';
  sessionId: string;
}

/**
 * Union type for all client-to-server messages
 */
export type ClientMessage =
  | PublishMessage
  | ListenMessage
  | UnlistenMessage
  | IdentifyMessage;

/** A RabbitMQ subscription with queue and consumer information. */
export interface RabbitMQSubscription {
  queue: string;
  consumerTag: string;
}

/** Connection data stored for each WebSocket client. */
export interface WebSocketConnectionData {
  ws: WebSocket;
  subscriptions: Map<string, RabbitMQSubscription>;
  context: WebSocketConnectionContext;
}

/** A hook function to intercept and process messages. */
export type Hook = (
  context: WebSocketConnectionContext,
  message: ClientMessage,
  next: () => Promise<void>
) => Promise<void>;

