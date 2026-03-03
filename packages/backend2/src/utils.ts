/**
 * Bundles a JSON header and an optional binary payload into a single ArrayBuffer.
 * Structure: [4 bytes (Header Length)] + [Header (JSON)] + [Optional Payload]
 */
export function bundleData(header: object, payload?: ArrayBuffer | Buffer): ArrayBuffer {
  // 1. Convert JSON Header to bytes
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(JSON.stringify(header));

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
    const payloadOffset = 4 + headerBytes.byteLength;
    // Handle both ArrayBuffer and Buffer
    const payloadBytes = Buffer.isBuffer(payload) ? payload : new Uint8Array(payload);
    view.set(payloadBytes, payloadOffset);
  }

  return masterBuffer;
}

/**
 * Unbundles an ArrayBuffer into a JSON header and optional binary payload.
 * Structure: [4 bytes (Header Length)] + [Header (JSON)] + [Optional Payload]
 * @returns [header, payload?] - Tuple of parsed header and optional payload
 */
export function unbundleData(buffer: ArrayBuffer): [any, ArrayBuffer?] {
  const dataView = new DataView(buffer);

  // 1. Read Header Length (first 4 bytes, Big Endian)
  const headerLength = dataView.getUint32(0, false);

  if (headerLength > 1024 * 1024) {
    throw new Error(`Header length ${headerLength} exceeds maximum allowed size`);
  }

  // 2. Extract and parse Header (JSON)
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const decoder = new TextDecoder();
  const headerString = decoder.decode(headerBytes);
  const header = JSON.parse(headerString);

  // 3. Extract Payload (if any exists after header)
  const payloadOffset = 4 + headerLength;
  const payload = payloadOffset < buffer.byteLength
    ? buffer.slice(payloadOffset)
    : undefined;

  return [header, payload];
}

export async function retry<T>(fn: () => Promise<T>, delays = [0, 100, 200, 400]) {
  let error;
  for (let delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await fn();
    } catch (err) {
      error = err;
    }
  }
  throw error;
}
