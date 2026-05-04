import { bundleData, unbundleData, retry } from '../src/utils';
import type { MessageHeader } from '../src/index';

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

  it('should bundle header with Buffer payload', () => {
    const header: MessageHeader = { routingKey: 'test.route' };
    const payload = Buffer.from('Hello World');
    const result = bundleData(header, payload);

    expect(result).toBeInstanceOf(Uint8Array);

    const expectedHeaderLen = JSON.stringify(header).length;
    const expectedTotalLen = 4 + expectedHeaderLen + payload.byteLength;
    expect(result.byteLength).toBe(expectedTotalLen);

    // Verify payload is at the correct offset
    const payloadOffset = 4 + expectedHeaderLen;
    const extractedPayload = result.slice(payloadOffset);
    expect(Buffer.from(extractedPayload)).toEqual(payload);
  });

  it('should bundle header with ArrayBuffer payload', () => {
    const header: MessageHeader = { routingKey: 'test.route' };
    const payload = new TextEncoder().encode('Test payload').buffer;
    const result = bundleData(header, payload);

    expect(result).toBeInstanceOf(Uint8Array);

    const expectedHeaderLen = JSON.stringify(header).length;
    const expectedTotalLen = 4 + expectedHeaderLen + payload.byteLength;
    expect(result.byteLength).toBe(expectedTotalLen);
  });

  it('should write header length in big-endian', () => {
    const header: MessageHeader = { routingKey: 'test' };
    const result = bundleData(header);

    const dataView = new DataView(result.buffer, result.byteOffset, result.byteLength);
    const headerLengthBE = dataView.getUint32(0, false); // Big-endian

    const expectedLength = JSON.stringify(header).length;
    expect(headerLengthBE).toBe(expectedLength);
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
    const originalPayload = Buffer.from('Test payload');
    const bundled = bundleData(originalHeader, originalPayload);

    const [header, payload] = unbundleData(bundled.buffer as ArrayBuffer);

    expect(header).toEqual(originalHeader);
    expect(payload).toBeDefined();
    expect(Buffer.from(payload!)).toEqual(originalPayload);
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

  it('should throw error if header length exceeds 1MB', () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);

    // Set header length to 2MB (exceeds 1MB limit)
    view.setUint32(0, 2 * 1024 * 1024, false);

    expect(() => unbundleData(buffer)).toThrow(
      'Header length 2097152 exceeds maximum allowed size'
    );
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
});

describe('retry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should succeed on first try', async () => {
    const fn = jest.fn().mockResolvedValue('success');

    const resultPromise = retry(fn);
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry with default delays [0, 100, 200, 400]', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success on 3rd try');

    const resultPromise = retry(fn);

    // First attempt (delay 0)
    await jest.advanceTimersByTimeAsync(0);
    // Second attempt (delay 100)
    await jest.advanceTimersByTimeAsync(100);
    // Third attempt (delay 200)
    await jest.advanceTimersByTimeAsync(200);

    const result = await resultPromise;

    expect(result).toBe('success on 3rd try');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should retry with custom delays', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValue('success on 2nd try');

    const customDelays = [50, 150];
    const resultPromise = retry(fn, customDelays);

    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(150);

    const result = await resultPromise;

    expect(result).toBe('success on 2nd try');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should return result on eventual success', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success on last try');

    const resultPromise = retry(fn);

    await jest.advanceTimersByTimeAsync(0 + 100 + 200 + 400);

    const result = await resultPromise;

    expect(result).toBe('success on last try');
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
