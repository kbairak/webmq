import { bundleData, unbundleData } from '../src/bundle';
import type { MessageHeader, ServerMessageHeader } from '../src/index';

describe('bundleData', () => {
  it('should bundle header only (no payload)', () => {
    const header: MessageHeader = { routingKey: 'test.route' };
    const result = bundleData(header);

    expect(result).toBeInstanceOf(Uint8Array);

    // Check header length (4 bytes, big-endian)
    const dataView = new DataView(result.buffer, result.byteOffset, result.byteLength);
    const headerLength = dataView.getUint32(0, false);

    const expectedHeader = JSON.stringify(header);
    expect(headerLength).toBe(expectedHeader.length);
    expect(result.byteLength).toBe(4 + expectedHeader.length);
  });

  it('should bundle header with ArrayBuffer payload', () => {
    const header: MessageHeader = { routingKey: 'test.route' };
    const payload = new TextEncoder().encode('Test payload').buffer;
    const result = bundleData(header, payload);

    expect(result).toBeInstanceOf(Uint8Array);

    const expectedHeaderLen = JSON.stringify(header).length;
    const expectedTotalLen = 4 + expectedHeaderLen + payload.byteLength;
    expect(result.byteLength).toBe(expectedTotalLen);

    // Verify payload is at the correct offset
    const payloadOffset = 4 + expectedHeaderLen;
    const extractedPayload = result.slice(payloadOffset);
    expect(new Uint8Array(extractedPayload.buffer)).toEqual(new Uint8Array(payload));
  });

  it('should return Uint8Array', () => {
    const header: MessageHeader = { routingKey: 'test' };
    const result = bundleData(header);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.constructor.name).toBe('Uint8Array');
  });

  it('should write header length in big-endian', () => {
    const header: MessageHeader = { routingKey: 'test' };
    const result = bundleData(header);

    const dataView = new DataView(result.buffer, result.byteOffset, result.byteLength);
    const headerLengthBE = dataView.getUint32(0, false); // Big-endian

    const expectedLength = JSON.stringify(header).length;
    expect(headerLengthBE).toBe(expectedLength);
  });

  it('should write header JSON correctly', () => {
    const header: MessageHeader = { routingKey: 'test.route', customField: 'value' };
    const result = bundleData(header);

    const headerLength = new DataView(result.buffer, result.byteOffset, result.byteLength).getUint32(0, false);
    const headerBytes = result.slice(4, 4 + headerLength);
    const headerString = new TextDecoder().decode(headerBytes);

    expect(JSON.parse(headerString)).toEqual(header);
  });

  it('should write payload at correct offset', () => {
    const header: MessageHeader = { routingKey: 'test' };
    const payload = new TextEncoder().encode('Hello World').buffer;
    const result = bundleData(header, payload);

    const headerLength = new DataView(result.buffer, result.byteOffset, result.byteLength).getUint32(0, false);
    const payloadOffset = 4 + headerLength;
    const extractedPayload = result.slice(payloadOffset);

    expect(new Uint8Array(extractedPayload.buffer)).toEqual(new Uint8Array(payload));
  });

  it('should handle complex header objects', () => {
    const header: MessageHeader = {
      routingKey: 'complex.route',
      bindingKey: 'pattern.*',
      customField: 'value',
      nested: { key: 'val' },
    };
    const result = bundleData(header);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBeGreaterThan(4);

    // Verify header can be extracted correctly
    const headerLength = new DataView(result.buffer, result.byteOffset, result.byteLength).getUint32(0, false);
    const headerBytes = result.slice(4, 4 + headerLength);
    const headerString = new TextDecoder().decode(headerBytes);
    expect(JSON.parse(headerString)).toEqual(header);
  });

  it('should handle empty payload (undefined)', () => {
    const header: MessageHeader = { routingKey: 'test' };
    const result = bundleData(header, undefined);

    const expectedLength = 4 + JSON.stringify(header).length;
    expect(result.byteLength).toBe(expectedLength);
  });

  it('should handle zero-length payload', () => {
    const header: MessageHeader = { routingKey: 'test' };
    const payload = new ArrayBuffer(0);
    const result = bundleData(header, payload);

    const expectedLength = 4 + JSON.stringify(header).length;
    expect(result.byteLength).toBe(expectedLength);
  });
});

describe('unbundleData', () => {
  it('should unbundle header only', () => {
    const originalHeader: MessageHeader = { routingKey: 'test.route' };
    const bundled = bundleData(originalHeader);

    const [header, payload] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(header).toEqual(originalHeader);
    expect(payload).toBeUndefined();
  });

  it('should unbundle header with payload', () => {
    const originalHeader: MessageHeader = { routingKey: 'test.route' };
    const originalPayload = new TextEncoder().encode('Test payload').buffer;
    const bundled = bundleData(originalHeader, originalPayload);

    const [header, payload] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(header).toEqual(originalHeader);
    expect(payload).toBeDefined();
    expect(new Uint8Array(payload!)).toEqual(new Uint8Array(originalPayload));
  });

  it('should parse JSON header correctly', () => {
    const originalHeader: MessageHeader = {
      routingKey: 'complex.route',
      customField: 'value',
      number: 42,
      bool: true,
    };
    const bundled = bundleData(originalHeader);

    const [header] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(header).toEqual(originalHeader);
    expect(header.routingKey).toBe('complex.route');
    expect(header.customField).toBe('value');
    expect(header.number).toBe(42);
    expect(header.bool).toBe(true);
  });

  it('should return ServerMessageHeader type', () => {
    const originalHeader: ServerMessageHeader = {
      routingKey: 'test.route',
      bindingKey: 'test.*',
    };
    const bundled = bundleData(originalHeader);

    const [header, payload] = unbundleData(bundled.buffer as ArrayBuffer);

    // Type assertion - if this compiles, the type is correct
    const typedHeader: ServerMessageHeader = header;
    expect(typedHeader.routingKey).toBe('test.route');
    expect(payload).toBeUndefined();
  });

  it('should handle big-endian header length correctly', () => {
    // Create a bundled message manually to test big-endian reading
    const header = { routingKey: 'test' };
    const headerJson = JSON.stringify(header);
    const headerBytes = new TextEncoder().encode(headerJson);

    const buffer = new ArrayBuffer(4 + headerBytes.byteLength);
    const view = new DataView(buffer);

    // Write length as big-endian
    view.setUint32(0, headerBytes.byteLength, false);
    new Uint8Array(buffer).set(headerBytes, 4);

    const [parsedHeader] = unbundleData(buffer);
    expect(parsedHeader).toEqual(header);
  });

  it('should handle empty payload correctly', () => {
    const originalHeader: MessageHeader = { routingKey: 'test' };
    const bundled = bundleData(originalHeader);

    const [header, payload] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(header).toEqual(originalHeader);
    expect(payload).toBeUndefined();
  });

  it('should roundtrip bundleData and unbundleData', () => {
    const originalHeader: MessageHeader = {
      routingKey: 'user.created',
      bindingKey: 'user.*',
    };
    const originalPayload = new TextEncoder().encode('{"id":123,"name":"Alice"}').buffer;

    const bundled = bundleData(originalHeader, originalPayload);
    const [header, payload] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(header).toEqual(originalHeader);
    expect(new Uint8Array(payload!)).toEqual(new Uint8Array(originalPayload));
  });

  it('should handle complex nested headers', () => {
    const originalHeader: MessageHeader = {
      routingKey: 'test',
      nested: { deep: { value: 123 } },
      array: [1, 2, 3],
    };
    const bundled = bundleData(originalHeader);

    const [header] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(header).toEqual(originalHeader);
    expect(header.nested).toEqual({ deep: { value: 123 } });
    expect(header.array).toEqual([1, 2, 3]);
  });

  it('should handle special characters in header', () => {
    const originalHeader: MessageHeader = {
      routingKey: 'test',
      message: 'Hello "World" with \n newlines and \t tabs',
    };
    const bundled = bundleData(originalHeader);

    const [header] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(header).toEqual(originalHeader);
  });

  it('should extract payload at correct offset', () => {
    const header: MessageHeader = { routingKey: 'test.route' };
    const payloadData = new Uint8Array([1, 2, 3, 4, 5]);
    const bundled = bundleData(header, payloadData.buffer);

    const [, payload] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(new Uint8Array(payload!)).toEqual(payloadData);
  });
});
