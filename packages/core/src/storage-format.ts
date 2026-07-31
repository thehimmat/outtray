/**
 * On-disk format guards for the encrypted store (ADR-0011).
 *
 * `better-sqlite3-multiple-ciphers` is named after SQLCipher but implements
 * several cipher schemes, and its defaults are wrong for us twice over: a new
 * database is chacha20, and even `PRAGMA cipher = 'sqlcipher'` alone writes a
 * file that no other SQLCipher implementation can open. Only
 * `cipher = 'sqlcipher'` followed by `legacy = 4` produces the upstream format
 * (docs/evals/sqlcipher-spike.md, "The two traps"). That matters twice: Phase 3
 * is meant to inherit this file rather than migrate it, and without `legacy = 4`
 * the SQLite header struct at bytes 16-23 is left in the clear.
 *
 * Neither trap is visible without testing for it, and both are exactly the kind
 * of thing a dependency bump changes silently. So the store asserts the format
 * twice at open time: once from the pragmas the driver reports, and once from
 * the bytes actually on disk, which is the assertion that survives a driver
 * that starts lying about its own pragmas.
 *
 * This module is pure, so the assertions are testable without the native module.
 */

/**
 * Pragmas that configure the upstream-compatible SQLCipher format, in the order
 * they must be issued (before the key, and `cipher` before `legacy`, which is
 * interpreted per cipher scheme).
 */
export const CIPHER_PRAGMAS = ["cipher = 'sqlcipher'", 'legacy = 4'] as const;

/** Value `PRAGMA cipher` must report after configuration. */
export const EXPECTED_CIPHER = 'sqlcipher';

/** Value `PRAGMA legacy` must report after configuration. */
export const EXPECTED_LEGACY = '4';

/** First 16 bytes of an unencrypted SQLite database. */
const SQLITE_MAGIC = 'SQLite format 3\0';

/** Bytes of the file header the assertions inspect. */
export const HEADER_BYTES = 24;

const SPIKE = 'docs/evals/sqlcipher-spike.md';

/** Thrown when the store's on-disk format is not the one ADR-0011 committed to. */
export class StorageFormatError extends Error {
  constructor(message: string) {
    super(`${message} See ADR-0011 and ${SPIKE}.`);
    this.name = 'StorageFormatError';
  }
}

/** Reads one pragma and returns the driver's raw result. */
export type PragmaReader = (pragma: string) => unknown;

/**
 * Reduce a driver pragma result to a scalar string.
 *
 * The driver answers scalar pragmas with a one-row array whose single column is
 * named after the value itself (`PRAGMA cipher` gives
 * `[{ sqlcipher: 'sqlcipher' }]`), and named pragmas with a normal column
 * (`[{ user_version: 3 }]`). Both reduce to the first value of the first row.
 *
 * Failure modes: returns null rather than throwing when the result is empty,
 * not an array, or a row with no columns, so callers decide what a missing
 * pragma means.
 */
export function readPragmaScalar(result: unknown): string | null {
  if (!Array.isArray(result) || result.length === 0) return null;
  const row = result[0];
  if (typeof row !== 'object' || row === null) return null;
  const [value] = Object.values(row);
  return value === undefined || value === null ? null : String(value);
}

/**
 * Assert that the driver reports the ADR-0011 cipher configuration.
 *
 * Failure modes: throws `StorageFormatError` if `cipher` is not `sqlcipher`, if
 * `legacy` is not `4`, or if either pragma answers nothing (which is how a
 * dependency bump that renames or drops them would present). Propagates
 * whatever `read` throws.
 */
export function assertCipherPragmas(read: PragmaReader): void {
  const cipher = readPragmaScalar(read('cipher'));
  if (cipher !== EXPECTED_CIPHER) {
    throw new StorageFormatError(
      `Expected PRAGMA cipher = '${EXPECTED_CIPHER}', got ${cipher ?? 'no answer'}. ` +
        'The driver default is chacha20, which nothing else in the SQLCipher ecosystem can read.',
    );
  }
  const legacy = readPragmaScalar(read('legacy'));
  if (legacy !== EXPECTED_LEGACY) {
    throw new StorageFormatError(
      `Expected PRAGMA legacy = ${EXPECTED_LEGACY}, got ${legacy ?? 'no answer'}. ` +
        'Without it the file is unreadable by any other SQLCipher implementation ' +
        'and leaves the SQLite header struct in the clear.',
    );
  }
}

/**
 * True when bytes 16-23 of `header` are a readable SQLite header struct.
 *
 * Those eight bytes hold page size, write and read format versions, reserved
 * byte count and the three payload fractions. Every mode except `legacy = 4`
 * leaves them in the clear; `legacy = 4` encrypts the whole first page after
 * the salt, so they are ciphertext. The three fixed payload fractions
 * (`40 20 20`) make a false positive on ciphertext vanishingly unlikely.
 *
 * Failure modes: none. Returns false for a header shorter than `HEADER_BYTES`,
 * since a file with nothing written yet has no struct to leak.
 */
export function hasCleartextSqliteHeader(header: Uint8Array): boolean {
  if (header.length < HEADER_BYTES) return false;
  const pageSize = ((header[16] as number) << 8) | (header[17] as number);
  // 1 encodes 65536; otherwise a power of two of at least 512.
  const pageSizeOk = pageSize === 1 || (pageSize >= 512 && (pageSize & (pageSize - 1)) === 0);
  const writeVersion = header[18] as number;
  const readVersion = header[19] as number;
  const versionsOk = writeVersion >= 1 && writeVersion <= 2 && readVersion >= 1 && readVersion <= 2;
  const fractionsOk = header[21] === 0x40 && header[22] === 0x20 && header[23] === 0x20;
  return pageSizeOk && versionsOk && fractionsOk;
}

/**
 * Assert that the first bytes of the database file are those of an
 * upstream-compatible SQLCipher database.
 *
 * This is the assertion that does not trust the driver: it reads what was
 * actually written. Bytes 0-15 are the cipher salt in every mode and carry no
 * information, so only the magic string and the header struct are checked.
 *
 * Failure modes: throws `StorageFormatError` if the file is a plaintext SQLite
 * database, or if it is encrypted but still leaks the header struct (which
 * means `legacy = 4` did not take effect). Accepts a header shorter than
 * `HEADER_BYTES`, since a database with no pages written yet has nothing to
 * assert against.
 */
export function assertEncryptedHeader(header: Uint8Array): void {
  if (header.length < HEADER_BYTES) return;
  const magic = Buffer.from(header.subarray(0, SQLITE_MAGIC.length)).toString('latin1');
  if (magic === SQLITE_MAGIC) {
    throw new StorageFormatError(
      'The database file is not encrypted: it begins with the plaintext SQLite magic string.',
    );
  }
  if (hasCleartextSqliteHeader(header)) {
    throw new StorageFormatError(
      'The database file leaves the SQLite header struct at bytes 16-23 in the clear, ' +
        'so PRAGMA legacy = 4 did not take effect and the format is not upstream SQLCipher.',
    );
  }
}
