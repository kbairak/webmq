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
 *     └── NackMessage (negative acknowledgment)
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
 * Union type for all client-to-server messages
 */
export type ClientMessage =
  | ListenMessage
  | UnlistenMessage
  | EmitMessage
  | IdentifyMessage;

/**
 * Union type for all server-to-client messages
 */
export type ServerMessage = DataMessage | AckMessage | NackMessage;

/**
 * Context object passed to client-side hooks (persistent across actions)
 */
export interface ClientHookContext {
  client: any; // WebMQClient - avoiding circular reference
  [key: string]: any; // For user data from hooks
}

/**
 * Message object passed to client-side hooks
 */
export interface ClientHookMessage {
  action: 'publish' | 'listen' | 'message';
  routingKey?: string;
  payload?: any;
  bindingKey?: string;
  callback?: MessageCallback;
}

/**
 * Client-side hook function signature (matches backend pattern)
 */
export type ClientHook = (
  context: ClientHookContext,
  message: ClientHookMessage,
  next: () => Promise<void>
) => Promise<void>;

/**
 * Client-side hooks configuration
 */
export interface ClientHooks {
  pre?: ClientHook[];
  onPublish?: ClientHook[];
  onMessage?: ClientHook[];
  onListen?: ClientHook[];
}

/**
 * Configuration options for WebMQ client setup
 */
export interface WebMQClientOptions {
  maxReconnectAttempts?: number;
  maxQueueSize?: number;
  messageTimeout?: number;
  hooks?: ClientHooks;
}

/**
 * Options for client disconnection behavior
 */
export interface DisconnectOptions {
  onActiveListeners?: 'ignore' | 'throw' | 'clear';
}

/**
 * Queued message structure for offline scenarios
 */
export interface QueuedMessage {
  routingKey: string;
  payload: any;
  messageId: string;
  resolve: (value?: any) => void;
  reject: (reason?: any) => void;
}

/**
 * Pending message tracking structure for acknowledgments
 */
export interface PendingMessage {
  resolve: (value?: any) => void;
  reject: (reason?: any) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type MessageCallback = (payload: any) => void;