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

// Server sends this to confirm successful message processing
export interface AckMessage {
  action: 'ack';
  messageId: string;
  status: 'success';
}

// Server sends this to deliver routed message data to subscribed clients
export interface DataMessage {
  action: 'message';
  bindingKey: string;
  payload: any;
  routingKey?: string;
}

// Server sends this when message processing fails
export interface NackMessage {
  action: 'nack';
  messageId: string;
  error: string;
}

// Server sends this for general errors not tied to specific messages
export interface ErrorMessage {
  action: 'error';
  message: string;
}

/**
 * Union type for all client-to-server messages
 */
export type ClientMessage =
  | PublishMessage
  | ListenMessage
  | UnlistenMessage
  | IdentifyMessage;

/**
 * Union type for all server-to-client messages
 */
export type ServerMessage =
  | DataMessage
  | AckMessage
  | NackMessage
  | ErrorMessage;

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

export interface WebMQServerOptions {
  rabbitmqUrl: string;
  exchangeName: string;
  hooks?: {
    pre?: Hook[];
    onListen?: Hook[];
    onPublish?: Hook[];
    onUnlisten?: Hook[];
  };
}

// --- Action Processing Interfaces ---

export interface ActionContext {
  connectionId: string;
  connection: WebSocketConnectionData;
  subscriptionManager: any; // RabbitMQManager - avoiding circular dependency
  serverEmitter: EventEmitter;
}

export interface ActionResult {
  success: boolean;
  data?: any;
  error?: string;
}