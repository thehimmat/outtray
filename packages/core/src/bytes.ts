/**
 * Byte helpers that work in both hosts (ADR-0013): Node has `Buffer` and
 * `node:crypto`, the webview has neither, and both have Web Crypto and `btoa`.
 */

/**
 * The key a document is stored under: the hex SHA-256 of its bytes, so a moved
 * or renamed file is the same document (ADR-0011). Web Crypto, so it is the
 * same function in Node and in the webview.
 *
 * Failure modes: rejects only if Web Crypto is unavailable, which no supported
 * host lacks.
 */
export async function contentHashOf(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Standard base64 of `bytes`, as the model providers expect page images.
 *
 * Failure modes: none.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
