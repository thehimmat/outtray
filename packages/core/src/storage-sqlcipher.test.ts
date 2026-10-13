/**
 * Tests that need the real native module: the on-disk format, key custody at
 * the boundary, and the migration mechanism (ADR-0011).
 *
 * The behavioural contract lives in `storage-contract.test.ts`, which runs
 * against both implementations. What is here cannot be faked, because the point
 * is what `better-sqlite3-multiple-ciphers` actually writes to disk.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATABASE_FILE_MODE } from './app-paths.js';
import { DatabaseKeyError, generateDatabaseKey, StaticKeyProvider } from './db-key.js';
import { explainStorageError, StorageCorruptError } from './storage-errors.js';
import { hasCleartextSqliteHeader, StorageFormatError } from './storage-format.js';
import { MIGRATIONS, SCHEMA_VERSION, StorageMigrationError } from './storage-schema.js';
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
      extractorKey: null,
      indexKey: null,
      userType: null,
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
      extractorKey: null,
      indexKey: null,
      userType: null,
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
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
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
      extractorKey: null,
      indexKey: null,
      userType: null,
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

describe('migration 2 (ADR-0012)', () => {
  it('brings a version-1 database forward with null version keys on existing documents', async () => {
    const path = join(await workspace(), 'outtray.db');
    const provider = key();
    const { key: bytes } = await provider.getOrCreateKey();

    // Build the database a #79-era Outtray left behind: migration 1 only.
    const { default: Database } = await import('better-sqlite3-multiple-ciphers');
    const raw = new Database(path);
    raw.pragma("cipher = 'sqlcipher'");
    raw.pragma('legacy = 4');
    raw.pragma(`key = "x'${bytes.toString('hex')}'"`);
    for (const statement of MIGRATIONS[0]?.statements ?? []) raw.exec(statement);
    raw
      .prepare(
        'INSERT INTO documents (content_hash, path, type, extraction_json, reconciliation_json, scanned_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('hash-old', '/docs/old.png', null, null, null, 5);
    raw.pragma('user_version = 1');
    raw.close();

    const store = await openSqlcipherStorage({ path, keyProvider: provider });
    expect(await store.getDocument('hash-old')).toMatchObject({
      path: '/docs/old.png',
      extractorKey: null,
      indexKey: null,
      userType: null,
    });
    await store.close();
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
      extractorKey: null,
      indexKey: null,
      userType: null,
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
      extractorKey: null,
      indexKey: null,
      userType: null,
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

/**
 * The plaintext of every page, decrypted outside SQLite (SQLCipher 4 with a
 * raw key: AES-256-CBC over each page minus its 80-byte reserve, IV at the
 * start of the reserve; page 1's first 16 bytes are the salt). Free pages are
 * included, which is the point: SQL cannot see them.
 */
async function decryptedPages(path: string, rawKey: Buffer): Promise<Buffer> {
  const { createDecipheriv } = await import('node:crypto');
  const bytes = await readFile(path);
  const pageSize = 4096;
  const reserve = 80;
  const pages: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += pageSize) {
    const page = bytes.subarray(offset, offset + pageSize);
    const iv = page.subarray(pageSize - reserve, pageSize - reserve + 16);
    const decipher = createDecipheriv('aes-256-cbc', rawKey, iv);
    decipher.setAutoPadding(false);
    const body = page.subarray(offset === 0 ? 16 : 0, pageSize - reserve);
    pages.push(Buffer.concat([decipher.update(body), decipher.final()]));
  }
  return Buffer.concat(pages);
}

describe('purges hold physically, not only in SQL (#84)', () => {
  const SECRET = 'ZQ7735190246XK';

  it('the decryption helper does see deleted bytes when secure_delete is off (control)', async () => {
    const path = join(await workspace(), 'outtray.db');
    const rawKey = generateDatabaseKey();
    const { default: Database } = await import('better-sqlite3-multiple-ciphers');
    const raw = new Database(path);
    raw.pragma("cipher = 'sqlcipher'");
    raw.pragma('legacy = 4');
    raw.pragma(`key = "x'${rawKey.toString('hex')}'"`);
    raw.pragma('secure_delete = OFF');
    raw.exec('CREATE TABLE t (v TEXT)');
    raw.prepare('INSERT INTO t VALUES (?)').run(SECRET);
    raw.prepare('DELETE FROM t').run();
    raw.close();
    expect((await decryptedPages(path, rawKey)).includes(SECRET)).toBe(true);
  });

  it('switching identifier storage off leaves no trace of the value in any page', async () => {
    const path = join(await workspace(), 'outtray.db');
    const rawKey = generateDatabaseKey();
    const store = await openSqlcipherStorage({ path, keyProvider: new StaticKeyProvider(rawKey) });
    await store.putDocument({
      contentHash: 'hash-a',
      path: '/docs/a.png',
      type: null,
      extraction: null,
      reconciliation: null,
      scannedAt: 1,
      extractorKey: null,
      indexKey: null,
      userType: null,
    });
    await store.putIdentifiers('hash-a', [{ field: 'id_number', value: SECRET }]);
    expect((await decryptedPages(path, rawKey)).includes(SECRET)).toBe(true);
    await store.purgeIdentifiers();
    await store.close();
    const pages = await decryptedPages(path, rawKey);
    expect(pages.includes(SECRET)).toBe(false);
    expect(pages.includes(SECRET.slice(-4))).toBe(false);
  });
});

describe('a damaged store says so (#84)', () => {
  async function storeWithData(): Promise<{ path: string; provider: StaticKeyProvider }> {
    const path = join(await workspace(), 'outtray.db');
    const provider = key();
    const store = await openSqlcipherStorage({ path, keyProvider: provider });
    await store.putDocument({
      contentHash: 'hash-a',
      path: '/docs/a.png',
      type: null,
      extraction: null,
      reconciliation: null,
      scannedAt: 1,
      extractorKey: null,
      indexKey: null,
      userType: null,
    });
    await store.addLabels(
      Array.from({ length: 200 }, () => ({
        type: 'bill' as const,
        embedding: Array.from({ length: 64 }, (_, i) => i),
        provenance: 'seed' as const,
        documentHash: null,
        text: 'x'.repeat(200),
        embedModel: 'm',
      })),
    );
    await store.close();
    return { path, provider };
  }

  it('reports a file cut off mid-page as damaged, not as a wrong key', async () => {
    const { path, provider } = await storeWithData();
    const { size } = await stat(path);
    await truncate(path, size - 1000);
    const failure = openSqlcipherStorage({ path, keyProvider: provider });
    await expect(failure).rejects.toThrow(StorageCorruptError);
    await expect(failure).rejects.toThrow(/damaged.*delete it and re-scan/s);
  });

  it('a page-aligned cut surfaces as a corrupt-database error the CLI can explain', async () => {
    const { path, provider } = await storeWithData();
    const { size } = await stat(path);
    await truncate(path, Math.floor(size / 8192) * 4096);
    let failure: unknown;
    try {
      const store = await openSqlcipherStorage({ path, keyProvider: provider });
      await store.listLabels();
      await store.close();
    } catch (error) {
      failure = error;
    }
    expect(explainStorageError(failure, path)).toMatch(/damaged/);
  });
});
