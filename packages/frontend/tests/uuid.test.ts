import { v4 } from '../src/uuid';

describe('uuid.v4', () => {
  const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  describe('with crypto.getRandomValues available', () => {
    let mockGetRandomValues: jest.Mock;
    let originalCrypto: typeof global.crypto;

    beforeEach(() => {
      originalCrypto = global.crypto;
      mockGetRandomValues = jest.fn((array: Uint8Array) => {
        // Fill with predictable values for testing
        for (let i = 0; i < array.length; i++) {
          array[i] = i;
        }
        return array;
      });

      Object.defineProperty(global, 'crypto', {
        value: { getRandomValues: mockGetRandomValues },
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(global, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      });
    });

    it('should use crypto.getRandomValues when available', () => {
      const uuid = v4();

      expect(mockGetRandomValues).toHaveBeenCalledTimes(1);
      expect(mockGetRandomValues).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(uuid).toMatch(UUID_V4_REGEX);
    });

    it('should generate valid v4 UUID format', () => {
      const uuid = v4();

      expect(uuid).toMatch(UUID_V4_REGEX);
      // Check version bit is 4
      expect(uuid[14]).toBe('4');
      // Check variant bits (8, 9, a, or b)
      expect(['8', '9', 'a', 'b']).toContain(uuid[19].toLowerCase());
    });

    it('should set version and variant bits correctly', () => {
      mockGetRandomValues.mockImplementation((array: Uint8Array) => {
        // Fill with 0xFF to test bit masking
        array.fill(0xff);
        return array;
      });

      const uuid = v4();

      // Version should be 4
      expect(uuid[14]).toBe('4');
      // Variant should be 8-b (binary 10xx)
      expect(['8', '9', 'a', 'b']).toContain(uuid[19].toLowerCase());
    });

    it('should generate unique UUIDs', () => {
      let counter = 0;
      mockGetRandomValues.mockImplementation((array: Uint8Array) => {
        // Generate different values each time
        for (let i = 0; i < array.length; i++) {
          array[i] = (counter + i) % 256;
        }
        counter++;
        return array;
      });

      const uuids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        uuids.add(v4());
      }

      expect(uuids.size).toBe(100);
    });

    it('should format UUID with correct hyphen positions', () => {
      const uuid = v4();

      const parts = uuid.split('-');
      expect(parts).toHaveLength(5);
      expect(parts[0]).toHaveLength(8);
      expect(parts[1]).toHaveLength(4);
      expect(parts[2]).toHaveLength(4);
      expect(parts[3]).toHaveLength(4);
      expect(parts[4]).toHaveLength(12);
    });
  });

  describe('fallback to Math.random()', () => {
    let originalCrypto: typeof global.crypto;

    beforeEach(() => {
      originalCrypto = global.crypto;
      // Remove crypto to trigger fallback
      Object.defineProperty(global, 'crypto', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(global, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      });
    });

    it('should fall back to Math.random() when crypto is not available', () => {
      const uuid = v4();

      expect(uuid).toMatch(UUID_V4_REGEX);
    });

    it('should generate valid v4 UUID format in fallback mode', () => {
      const uuid = v4();

      expect(uuid).toMatch(UUID_V4_REGEX);
      // Version should be 4
      expect(uuid[14]).toBe('4');
      // Variant should be 8-b
      expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
    });

    it('should generate unique UUIDs in fallback mode', () => {
      const uuids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        uuids.add(v4());
      }

      // Should have high uniqueness (allowing for small chance of collision with Math.random)
      expect(uuids.size).toBeGreaterThan(95);
    });

    it('should format UUID correctly in fallback mode', () => {
      const uuid = v4();

      const parts = uuid.split('-');
      expect(parts).toHaveLength(5);
      expect(parts[0]).toHaveLength(8);
      expect(parts[1]).toHaveLength(4);
      expect(parts[2]).toHaveLength(4);
      expect(parts[3]).toHaveLength(4);
      expect(parts[4]).toHaveLength(12);
    });
  });

  describe('fallback when crypto.getRandomValues is missing', () => {
    let originalCrypto: typeof global.crypto;

    beforeEach(() => {
      originalCrypto = global.crypto;
      // crypto exists but getRandomValues doesn't
      Object.defineProperty(global, 'crypto', {
        value: {},
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(global, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      });
    });

    it('should fall back when getRandomValues is not available', () => {
      const uuid = v4();

      expect(uuid).toMatch(UUID_V4_REGEX);
      expect(uuid[14]).toBe('4');
    });
  });
});
