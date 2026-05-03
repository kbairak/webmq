import { MessageHeader, ServerMessageHeader } from './index';
/**
 * Bundles a JSON header and an optional binary payload into a single ArrayBuffer.
 * Structure: [4 bytes (Header Length)] + [Header (JSON)] + [Optional Payload]
 */
export function bundleData(header: MessageHeader, payload?: ArrayBuffer): Uint8Array {
  // 1. Convert JSON Header to bytes
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  // 2. Calculate Total Length
  // Always include 4 bytes for the length + the header bytes.
  // Only add payload length if it exists.
  const payloadLength = payload ? payload.byteLength : 0;
  const totalByteLength = 4 + headerBytes.byteLength + payloadLength;

  // 3. Create the Master Buffer
  const masterBuffer = new ArrayBuffer(totalByteLength);
  const view = new Uint8Array(masterBuffer);
  const dataView = new DataView(masterBuffer);

  // 4. Write the Header Length (Big Endian)
  dataView.setUint32(0, headerBytes.byteLength, false);

  // 5. Write the Header Bytes
  view.set(headerBytes, 4);

  // 6. Write the Payload (only if it exists)
  if (payload) {
    view.set(new Uint8Array(payload), 4 + headerBytes.byteLength);
  }

  // Convert ArrayBuffer to Uint8Array for React Native compatibility
  return new Uint8Array(masterBuffer);
}

/**
 * Unbundles an ArrayBuffer into a JSON header and optional binary payload.
 * Structure: [4 bytes (Header Length)] + [Header (JSON)] + [Optional Payload]
 * @returns [header, payload?] - Tuple of parsed header and optional payload
 */
export function unbundleData(buffer: ArrayBuffer): [ServerMessageHeader, ArrayBuffer?] {
  const dataView = new DataView(buffer);

  // 1. Read Header Length (first 4 bytes, Big Endian)
  const headerLength = dataView.getUint32(0, false);

  // 2. Extract and parse Header (JSON)
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const headerString = new TextDecoder().decode(headerBytes);
  const header = JSON.parse(headerString);

  // 3. Extract Payload (if any exists after header)
  const payloadOffset = 4 + headerLength;
  const payload = payloadOffset < buffer.byteLength ? buffer.slice(payloadOffset) : undefined;

  return [header, payload];
}
