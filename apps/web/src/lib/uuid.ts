/**
 * Generate a UUID in browsers served over both HTTPS and plain HTTP.
 *
 * crypto.randomUUID() is restricted to secure contexts, while this app can
 * be smoke-tested directly on an IP over HTTP. Prefer the native APIs when
 * available and keep a standards-shaped v4 fallback for older browsers.
 */
export function createUuid(): string {
  const cryptoApi = typeof globalThis !== 'undefined'
    ? (globalThis as typeof globalThis & {
        crypto?: {
          randomUUID?: () => string;
          getRandomValues?: (array: Uint8Array) => Uint8Array;
        };
      }).crypto
    : undefined;

  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
