import type { MessageHeader } from './types';

const MAX_HEADER_LENGTH = 1024 * 1024;

export function bundleData(
  header: MessageHeader,
  payload?: ArrayBuffer | Uint8Array
): ArrayBuffer {
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(JSON.stringify(header));

  const payloadLength = payload ? payload.byteLength : 0;
  const totalByteLength = 4 + headerBytes.byteLength + payloadLength;

  const masterBuffer = new ArrayBuffer(totalByteLength);
  const view = new Uint8Array(masterBuffer);
  const dataView = new DataView(masterBuffer);

  dataView.setUint32(0, headerBytes.byteLength, false);
  view.set(headerBytes, 4);

  if (payload) {
    const payloadOffset = 4 + headerBytes.byteLength;
    view.set(
      payload instanceof Uint8Array ? payload : new Uint8Array(payload),
      payloadOffset
    );
  }

  return masterBuffer;
}

export function unbundleData(
  buffer: ArrayBuffer | Uint8Array
): [MessageHeader, ArrayBuffer | undefined] {
  const source =
    buffer instanceof Uint8Array
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      : buffer;
  const dataView = new DataView(source);

  const headerLength = dataView.getUint32(0, false);

  if (headerLength > MAX_HEADER_LENGTH) {
    throw new Error(
      `Header length ${headerLength} exceeds maximum allowed size`
    );
  }

  const headerBytes = new Uint8Array(source, 4, headerLength);
  const decoder = new TextDecoder();
  const headerString = decoder.decode(headerBytes);
  const header = JSON.parse(headerString) as MessageHeader;

  const payloadOffset = 4 + headerLength;
  const payload =
    payloadOffset < source.byteLength
      ? source.slice(payloadOffset)
      : undefined;

  return [header, payload];
}
