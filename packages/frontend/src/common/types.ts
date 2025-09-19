// Auto-generated from /common - do not edit directly
/**
 * Shared type definitions for WebMQ packages
 *
 * This file is copied to both backend and frontend packages during build.
 * Source of truth: /common/types.ts
 */

// --- Message Type Hierarchy ---

/**
 * Message Type Hierarchy:
 *
 * Message (base)
 * ├── OutgoingMessage (client → server)
 * │   ├── ListenMessage (establish listener)
 * │   ├── UnlistenMessage (remove listener)
 * │   ├── EmitMessage (publish data)
 * │   └── IdentifyMessage (client identification)
 * └── IncomingMessage (server → client)
 *     ├── DataMessage (routed message data)
 *     ├── AckMessage (acknowledgment)
 *     ├── NackMessage (negative acknowledgment)
 *     └── ErrorMessage (error notification)
 */

/**
 * Base interface for all WebMQ messages
 */
export interface Message {
  action: string;
}

/**
 * Base interface for all client-to-server messages
 */
export interface OutgoingMessage extends Message {
  action: string;
}

/**
 * Base interface for all server-to-client messages
 */
export interface IncomingMessage extends Message {
  action: string;
}

/**
 * Message sent to establish a listener for a specific routing pattern
 */
export interface ListenMessage extends OutgoingMessage {
  action: 'listen';
  bindingKey: string;
}

/**
 * Message sent to remove a listener for a specific routing pattern
 */
export interface UnlistenMessage extends OutgoingMessage {
  action: 'unlisten';
  bindingKey: string;
}

/**
 * Message sent to identify client for persistent sessions
 */
export interface IdentifyMessage extends OutgoingMessage {
  action: 'identify';
  sessionId: string;
}

/**
 * Message sent to publish data to a routing key
 */
export interface EmitMessage extends OutgoingMessage {
  action: 'publish';
  routingKey: string;
  payload: any;
  messageId: string;
}

/**
 * Message received from server containing routed data
 */
export interface DataMessage extends IncomingMessage {
  action: 'message';
  bindingKey: string;
  payload: any;
  routingKey?: string;
}

/**
 * Acknowledgment message received from server
 */
export interface AckMessage extends IncomingMessage {
  action: 'ack';
  messageId: string;
  status: 'success' | 'error';
  error?: string;
}

/**
 * Negative acknowledgment message received from server
 */
export interface NackMessage extends IncomingMessage {
  action: 'nack';
  messageId: string;
  error: string;
}

/**
 * Error message sent from server
 */
export interface ErrorMessage extends IncomingMessage {
  action: 'error';
  message: string;
}

/**
 * Union type for all client-to-server messages
 */
export type ClientMessage = ListenMessage | UnlistenMessage | EmitMessage | IdentifyMessage;

/**
 * Union type for all server-to-client messages
 */
export type ServerMessage = DataMessage | AckMessage | NackMessage | ErrorMessage;

// Backend-specific types (when used in backend context)

/**
 * Generic client message interface for backend processing
 */
export interface BackendClientMessage extends Message {
  action: 'publish' | 'listen' | 'unlisten';
  routingKey?: string;
  bindingKey?: string;
  payload?: any;
  messageId?: string;
}

/**
 * Message sent from client to publish data (backend version)
 */
export interface PublishMessage extends Message {
  action: 'publish';
  routingKey: string;
  payload: any;
  messageId?: string;
}

/**
 * Message sent from client to establish listener (backend version)
 */
export interface BackendListenMessage extends Message {
  action: 'listen';
  bindingKey: string;
}

/**
 * Message sent from client to remove listener (backend version)
 */
export interface BackendUnlistenMessage extends Message {
  action: 'unlisten';
  bindingKey: string;
}