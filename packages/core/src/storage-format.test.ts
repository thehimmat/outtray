import { describe, expect, it } from 'vitest';
import {
  assertCipherPragmas,
  assertEncryptedHeader,
  CIPHER_PRAGMAS,
  hasCleartextSqliteHeader,
  readPragmaScalar,
  StorageFormatError,
} from './storage-format.js';

/** Build a fake pragma reader over the shapes better-sqlite3 actually returns. */
function reader(values: Record<string, unknown>) {
  return (pragma: string): unknown => values[pragma];
}

// Real bytes 0-23 captured from files written by better-sqlite3-multiple-ciphers
// 12.11.1 under each configuration (docs/evals/sqlcipher-spike.md, "The two traps").
const HEADERS = {
  plaintext: '53514c69746520666f726d61742033001000010100402020',
  chacha20: 'ccf7b679e08ea820f41d830628acec8c1000010120402020',
  sqlcipherNoLegacy: '964f9e004019040d2fee80d677a3a8761000010150402020',
  sqlcipherLegacy4: '8145a61ee58264b90f10261a5f4446c1370ced5148f8a022',
} as const;

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

describe('CIPHER_PRAGMAS', () => {
  it('sets the cipher before legacy mode, in that order', () => {
    // Order is load-bearing: `legacy` is interpreted per-cipher, so setting it
    // before the cipher configures the wrong scheme.
    expect(CIPHER_PRAGMAS).toEqual(["cipher = 'sqlcipher'", 'legacy = 4']);
  });
});

describe('readPragmaScalar', () => {
  it('reads the driver key-equals-value row shape', () => {
    expect(readPragmaScalar([{ sqlcipher: 'sqlcipher' }])).toBe('sqlcipher');
    expect(readPragmaScalar([{ '4': '4' }])).toBe('4');
  });

  it('reads a named-column row', () => {
    expect(readPragmaScalar([{ user_version: 3 }])).toBe('3');
  });

  it('returns null for an empty or unrecognized result', () => {
    expect(readPragmaScalar([])).toBeNull();
    expect(readPragmaScalar(undefined)).toBeNull();
    expect(readPragmaScalar([{}])).toBeNull();
  });
});

describe('assertCipherPragmas', () => {
  it('accepts the recommended configuration', () => {
    expect(() =>
      assertCipherPragmas(reader({ cipher: [{ sqlcipher: 'sqlcipher' }], legacy: [{ '4': '4' }] })),
    ).not.toThrow();
  });

  it('rejects the driver default cipher, which is chacha20 and not SQLCipher', () => {
    expect(() =>
      assertCipherPragmas(reader({ cipher: [{ chacha20: 'chacha20' }], legacy: [{ '0': '0' }] })),
    ).toThrow(StorageFormatError);
  });

  it('rejects SQLCipher without legacy = 4, which no other implementation can read', () => {
    const fail = () =>
      assertCipherPragmas(reader({ cipher: [{ sqlcipher: 'sqlcipher' }], legacy: [{ '0': '0' }] }));
    expect(fail).toThrow(StorageFormatError);
    expect(fail).toThrow(/legacy/);
  });

  it('rejects a pragma the driver no longer answers', () => {
    // A dependency bump that renames or drops these pragmas must fail loudly
    // rather than leave the on-disk format unasserted.
    expect(() => assertCipherPragmas(reader({ cipher: [], legacy: [{ '4': '4' }] }))).toThrow(
      StorageFormatError,
    );
  });
});

describe('hasCleartextSqliteHeader', () => {
  it('detects the cleartext header struct left by every non-legacy mode', () => {
    expect(hasCleartextSqliteHeader(bytes(HEADERS.plaintext))).toBe(true);
    expect(hasCleartextSqliteHeader(bytes(HEADERS.chacha20))).toBe(true);
    expect(hasCleartextSqliteHeader(bytes(HEADERS.sqlcipherNoLegacy))).toBe(true);
  });

  it('does not fire on a legacy = 4 file, where bytes 16-23 are ciphertext', () => {
    expect(hasCleartextSqliteHeader(bytes(HEADERS.sqlcipherLegacy4))).toBe(false);
  });

  it('does not fire on a file too short to hold a header', () => {
    expect(hasCleartextSqliteHeader(new Uint8Array(0))).toBe(false);
    expect(hasCleartextSqliteHeader(bytes(HEADERS.plaintext).subarray(0, 20))).toBe(false);
  });
});

describe('assertEncryptedHeader', () => {
  it('accepts a legacy = 4 header', () => {
    expect(() => assertEncryptedHeader(bytes(HEADERS.sqlcipherLegacy4))).not.toThrow();
  });

  it('accepts a file with nothing written yet', () => {
    expect(() => assertEncryptedHeader(new Uint8Array(0))).not.toThrow();
  });

  it('rejects a plaintext SQLite file by its magic string', () => {
    const fail = () => assertEncryptedHeader(bytes(HEADERS.plaintext));
    expect(fail).toThrow(StorageFormatError);
    expect(fail).toThrow(/not encrypted/);
  });

  it('rejects an encrypted file that still leaks the header struct', () => {
    const fail = () => assertEncryptedHeader(bytes(HEADERS.sqlcipherNoLegacy));
    expect(fail).toThrow(StorageFormatError);
    expect(fail).toThrow(/legacy = 4/);
  });
});
