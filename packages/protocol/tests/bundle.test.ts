import type { MessageHeader } from '../src/types';
import { bundleData, unbundleData } from '../src/bundle';
import { newMessageId } from '../src/id';
import { makePing, makePong, makeAck, makeNack, isPong, isAck, isNack } from '../src/messages';

describe('bundleData / unbundleData', () => {
  it('should round-trip header-only', () => {
    const header: MessageHeader = { action: 'ping', messageId: 'abc' };
    const [outHeader, outPayload] = unbundleData(bundleData(header));
    expect(outHeader).toEqual(header);
    expect(outPayload).toBeUndefined();
  });

  it('should round-trip header with payload', () => {
    const header: MessageHeader = { action: 'publish', routingKey: 'test' };
    const payload = new TextEncoder().encode('hello world').buffer;
    const [outHeader, outPayload] = unbundleData(bundleData(header, payload));
    expect(outHeader).toEqual(header);
    expect(new TextDecoder().decode(outPayload)).toBe('hello world');
  });

  it('should accept Uint8Array input with nonzero offset', () => {
    const header: MessageHeader = { action: 'identify', sessionId: 'sess' };
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const bundled = bundleData(header, payload);
    const offset = 10;
    const padded = new Uint8Array(offset + bundled.byteLength);
    padded.set(new Uint8Array(bundled), offset);
    const sliced = new Uint8Array(padded.buffer, offset, bundled.byteLength);
    const [outHeader, outPayload] = unbundleData(sliced);
    expect(outHeader).toEqual(header);
    expect(new Uint8Array(outPayload!)).toEqual(payload);
  });

  it('should reject oversized headers (>1 MB)', () => {
    const bigString = 'x'.repeat(1024 * 1024 + 1);
    expect(() => bundleData({ action: 'publish', data: bigString })).not.toThrow();
    const bundled = bundleData({ action: 'publish', data: bigString });
    expect(() => unbundleData(bundled)).toThrow('exceeds maximum allowed size');
  });

  it('golden vector test', () => {
    const header: MessageHeader = { action: 'ping', messageId: 'golden' };
    const bundled = bundleData(header);
    const view = new DataView(bundled);
    const headerLength = view.getUint32(0, false);
    expect(headerLength).toBeGreaterThan(0);
    const headerBytes = new Uint8Array(bundled, 4, headerLength);
    const decoded = new TextDecoder().decode(headerBytes);
    expect(JSON.parse(decoded)).toEqual(header);
    expect(bundled.byteLength).toBe(4 + headerBytes.byteLength);
  });
});

describe('messages', () => {
  it('should create ping', () => {
    const ping = makePing();
    expect(ping.action).toBe('ping');
    expect(ping.messageId).toBeDefined();
  });

  it('should create pong', () => {
    const pong = makePong('msg-1');
    expect(pong).toEqual({ action: 'pong', messageId: 'msg-1' });
  });

  it('should create ack', () => {
    const ack = makeAck('msg-1');
    expect(ack).toEqual({ action: 'ack', messageId: 'msg-1' });
  });

  it('should create nack with error', () => {
    const nack = makeNack('msg-1', 'something went wrong');
    expect(nack).toEqual({ action: 'nack', messageId: 'msg-1', error: 'something went wrong' });
  });

  it('should create nack without error', () => {
    const nack = makeNack('msg-1');
    expect(nack).toEqual({ action: 'nack', messageId: 'msg-1' });
  });

  it('isPong guard', () => {
    expect(isPong({ action: 'pong', messageId: 'x' })).toBe(true);
    expect(isPong({ action: 'ping', messageId: 'x' })).toBe(false);
  });

  it('isAck guard', () => {
    expect(isAck({ action: 'ack', messageId: 'x' })).toBe(true);
    expect(isAck({ action: 'nack', messageId: 'x' })).toBe(false);
  });

  it('isNack guard', () => {
    expect(isNack({ action: 'nack', messageId: 'x' })).toBe(true);
    expect(isNack({ action: 'ack', messageId: 'x' })).toBe(false);
  });
});

describe('newMessageId', () => {
  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newMessageId()));
    expect(ids.size).toBe(100);
  });
});
