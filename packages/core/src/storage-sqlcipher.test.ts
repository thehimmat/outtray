/**
 * Tests that need the real native module: the on-disk format, key custody at
 * the boundary, and the migration mechanism (ADR-0011).
 *
 * The behavioural contract lives in `storage-contract.test.ts`, which runs
 * against both implementations. What is here cannot be faked, because the point
 * is what `better-sqlite3-multiple-ciphers` actually writes to disk.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATABASE_FILE_MODE } from './app-paths.js';
import { DatabaseKeyError, generateDatabaseKey, StaticKeyProvider } from './db-key.js';
import { hasCleartextSqliteHeader, StorageFormatError } from './storage-format.js';
import { StorageMigrationError } from './storage-schema.js';
import { openSqlcipherStorage } from './storage-sqlcipher.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'outtray-sqlcipher-'));
  dirs.push(dir);
  return dir;
}

const key = () => new StaticKeyProvider(generateDatabaseKey());

describe('openSqlcipherStorage on-disk format', () => {
  it('writes a file whose header struct is not in the clear', async () => {
    // The legacy = 4 assertion, proven against the bytes rather than the pragmas.
    // Without it, bytes 16-23 hold page size, format versions and the payload
    // fractions (docs/evals/sqlcipher-spike.md, "The two traps").
    const path = join(await workspace(), 'outtray.db');
    const store = await openSqlcipherStorage({ path, keyProvider: key() });
    await store.putDocument({
      contentHash: 'hash-a',
      path: '/docs/a.png',
      type: null,
      extraction: null,
      reconciliation: null,
      scannedAt: 1,
    });
    await store.close();

    const header = await readFile(path);
    expect(header.subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\0');
    expect(hasCleartextSqliteHeader(header.subarray(0, 24))).toBe(false);
  });

  it('rejects a plaintext SQLite file rather than adopting it', async () => {
    const path = join(await workspace(), 'outtray.db');
    // A plaintext database is the ADR-0007 fallback posture, not this one, so
    // finding one where the encrypted store belongs must stop.
    const plaintextHeader = Buffer.alloc(24);
    plaintextHeader.write('SQLite format 3\0', 0, 'latin1');
    await writeFile(path, plaintextHeader);
    await expect(openSqlcipherStorage({ path, keyProvider: key() })).rejects.toThrow(
      /not encrypted|does not open/,
    );
  });

  it('creates the containing directory owner-only and the database owner-readable', async () => {
    const path = join(await workspace(), 'nested', 'outtray.db');
    const store = await openSqlcipherStorage({ path, keyProvider: key() });
    await store.close();
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(DATABASE_FILE_MODE);
  });

  it('tightens the directory even when it already exists too permissively', async () => {
    // mkdir does nothing to an existing directory, so creating it is not enough
    // to guarantee the mode; the explicit chmod is what makes the claim true.
    const nested = join(await workspace(), 'loose');
    await mkdir(nested);
    await chmod(nested, 0o777);
    const store = await openSqlcipherStorage({
      path: join(nested, 'outtray.db'),
      keyProvider: key(),
    });
    await store.close();
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });
});

describe('openSqlcipherStorage key custody', () => {
  it('reopens with the same key and finds the data', async () => {
    const path = join(await workspace(), 'outtray.db');
    const provider = key();
    const first = await openSqlcipherStorage({ path, keyProvider: provider });
    await first.putDocument({
      contentHash: 'hash-a',
      path: '/docs/a.png',
      type: 'bill',
      extraction: null,
      reconciliation: null,
      scannedAt: 7,
    });
    await first.close();

    const second = await openSqlcipherStorage({ path, keyProvider: provider });
    expect((await second.getDocument('hash-a'))?.path).toBe('/docs/a.png');
    await second.close();
  });

  it('refuses a wrong key instead of reporting an empty store', async () => {
    const path = join(await workspace(), 'outtray.db');
    const first = await openSqlcipherStorage({ path, keyProvider: key() });
    await first.close();
    await expect(openSqlcipherStorage({ path, keyProvider: key() })).rejects.toThrow(
      DatabaseKeyError,
    );
  });

  it('refuses to open when a key was just created next to an existing database', async () => {
    // The Keychain item is gone but the file is not: nothing can decrypt it, and
    // the honest answer is to say so rather than to overwrite the user's index.
    const path = join(await workspace(), 'outtray.db');
    const first = await openSqlcipherStorage({ path, keyProvider: key() });
    await first.close();

    const freshlyCreated = new StaticKeyProvider(generateDatabaseKey(), true);
    const failure = openSqlcipherStorage({ path, keyProvider: freshlyCreated });
    await expect(failure).rejects.toThrow(DatabaseKeyError);
    await expect(failure).rejects.toThrow(/delete the file and re-scan/);
    // The file it refused to open is still there, byte for byte.
    expect((await stat(path)).size).toBeGreaterThan(0);
  });

  it('accepts a newly created key when there is no database yet', async () => {
    const path = join(await workspace(), 'outtray.db');
    const store = await openSqlcipherStorage({
      path,
      keyProvider: new StaticKeyProvider(generateDatabaseKey(), true),
    });
    await store.close();
  });
});

describe('openSqlcipherStorage migrations', () => {
  it('brings a new database to the current schema version', async () => {
    const path = join(await workspace(), 'outtray.db');
    const store = await openSqlcipherStorage({ path, keyProvider: key() });
    expect(store.schemaVersion).toBe(1);
    await store.close();
  });

  it('is idempotent across reopens', async () => {
    const path = join(await workspace(), 'outtray.db');
    const provider = key();
    for (let i = 0; i < 3; i++) {
      const store = await openSqlcipherStorage({ path, keyProvider: provider });
      await store.close();
    }
    const store = await openSqlcipherStorage({ path, keyProvider: provider });
    expect(await store.listDocuments()).toEqual([]);
    await store.close();
  });

  it('cascades chunk deletion through the foreign key, which SQLite defaults off', async () => {
    const path = join(await workspace(), 'outtray.db');
    const store = await openSqlcipherStorage({ path, keyProvider: key() });
    await store.putDocument({
      contentHash: 'hash-a',
      path: '/docs/a.png',
      type: null,
      extraction: null,
      reconciliation: null,
      scannedAt: 1,
    });
    await store.putChunks('hash-a', [
      { documentHash: 'hash-a', chunkIndex: 0, page: null, text: 'x', embedding: [1, 0] },
    ]);
    await store.deleteDocument('hash-a');
    expect(await store.listChunks()).toEqual([]);
    await store.close();
  });

  it('refuses a database written by a newer schema', async () => {
    const path = join(await workspace(), 'outtray.db');
    const provider = key();
    const store = await openSqlcipherStorage({ path, keyProvider: provider });
    await store.close();

    // Reach past the interface deliberately: this is the state a future release
    // leaves behind, and there is no other way to produce it today.
    const { default: Database } = await import('better-sqlite3-multiple-ciphers');
    const raw = new Database(path);
    raw.pragma("cipher = 'sqlcipher'");
    raw.pragma('legacy = 4');
    const { key: bytes } = await provider.getOrCreateKey();
    raw.pragma(`key = "x'${bytes.toString('hex')}'"`);
    raw.pragma('user_version = 99');
    raw.close();

    await expect(openSqlcipherStorage({ path, keyProvider: provider })).rejects.toThrow(
      StorageMigrationError,
    );
  });
});

describe('embedding round trip', () => {
  it('survives the float32 BLOB with the precision cosine ranking needs', async () => {
    const path = join(await workspace(), 'outtray.db');
    const store = await openSqlcipherStorage({ path, keyProvider: key() });
    await store.putDocument({
      contentHash: 'hash-a',
      path: '/docs/a.png',
      type: null,
      extraction: null,
      reconciliation: null,
      scannedAt: 1,
    });
    const embedding = Array.from({ length: 768 }, (_, i) => Math.sin(i) / 3);
    await store.putChunks('hash-a', [
      { documentHash: 'hash-a', chunkIndex: 0, page: null, text: 'x', embedding },
    ]);
    const [stored] = await store.listChunks();
    expect(stored?.embedding).toHaveLength(768);
    for (const [i, value] of (stored?.embedding ?? []).entries()) {
      expect(value).toBeCloseTo(embedding[i] as number, 6);
    }
    await store.close();
  });

  it('refuses a non-finite embedding component at the write', async () => {
    const path = join(await workspace(), 'outtray.db');
    const store = await openSqlcipherStorage({ path, keyProvider: key() });
    await store.putDocument({
      contentHash: 'hash-a',
      path: '/docs/a.png',
      type: null,
      extraction: null,
      reconciliation: null,
      scannedAt: 1,
    });
    await expect(
      store.putChunks('hash-a', [
        {
          documentHash: 'hash-a',
          chunkIndex: 0,
          page: null,
          text: 'x',
          embedding: [1, Number.NaN],
        },
      ]),
    ).rejects.toThrow(RangeError);
    expect(await store.listChunks()).toEqual([]);
    await store.close();
  });
});

describe('StorageFormatError', () => {
  it('points at the ADR and the spike, because the fix is never obvious', () => {
    expect(new StorageFormatError('Something changed.').message).toContain(
      'docs/evals/sqlcipher-spike.md',
    );
  });
});
