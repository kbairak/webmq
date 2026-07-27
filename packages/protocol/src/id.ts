import { v4 as uuid } from 'uuid';

export function newMessageId(): string {
  return uuid();
}
