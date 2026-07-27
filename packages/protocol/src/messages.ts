import type { ClientMessageHeader, MessageHeader } from './types';
import { newMessageId } from './id';

export function makePing(): ClientMessageHeader {
  return { action: 'ping', messageId: newMessageId() };
}

export function makePong(messageId: string): ClientMessageHeader {
  return { action: 'pong', messageId };
}

export function makeAck(messageId: string): ClientMessageHeader {
  return { action: 'ack', messageId };
}

export function makeNack(messageId: string, error?: string): ClientMessageHeader {
  return { action: 'nack', messageId, ...(error ? { error } : {}) };
}

export function isPong(header: MessageHeader): boolean {
  return header.action === 'pong';
}

export function isAck(header: MessageHeader): boolean {
  return header.action === 'ack';
}

export function isNack(header: MessageHeader): boolean {
  return header.action === 'nack';
}
