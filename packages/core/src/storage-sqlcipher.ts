/**
 * The encrypted SQLite `StorageProvider` (ADR-0011).
 *
 * This is the only file in `packages/core` that touches a native module, which
 * is the point of the seam: `better-sqlite3-multiple-ciphers` lives here and
 * nowhere else, so domain logic stays plain TypeScript and Phase 3 replaces
 * this one adapter rather than the code above it.
 *
 * Opening a store is deliberately noisy about failure. In order it ensures the
 * data directory is owner-only, gets the key, refuses to continue if a key was
 * just created next to a database that already exists (the old key is gone and
 * nothing can decrypt that file), applies the ADR-0011 cipher pragmas before
 * the key, proves the key by reading, asserts the pragmas the driver reports,
 * migrates the schema, and finally asserts the bytes actually on disk. The last
 * check is the one that catches a dependency bump silently changing the on-disk
 * format, which is the trap `docs/evals/sqlcipher-spike.md` found.
 *
 * The driver is synchronous; the interface is async because Phase 3 will be.
 */

import { chmod, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { DATABASE_FILE_MODE, ensureAppDataDir } from './app-paths.js';
import type { DatabaseKeyProvider } from './db-key.js';
import { DatabaseKeyError } from './db-key.js';
import { DOCUMENT_TYPES, type DocumentExtraction, type DocumentType } from './extraction-schema.js';
import type { Reconciliation } from './reconcile.js';
import {
  assertCipherPragmas,
  assertEncryptedHeader,
  CIPHER_PRAGMAS,
  HEADER_BYTES,
  readPragmaScalar,
} from './storage-format.js';
import {
  asLabelProvenance,
  assertChunkBatch,
  type NewLabel,
  StorageError,
  type StorageProvider,
  type StoredChunk,
  type StoredDocument,
  type StoredLabel,
} from './storage-provider.js';
import {
  decodeEmbedding,
  encodeEmbedding,
  pendingMigrations,
  SCHEMA_VERSION,
} from './storage-schema.js';

type Db = Database.Database;

/** A `documents` row as SQLite returns it. */
interface DocumentRow {
  content_hash: string;
  path: string;
  type: string | null;
  extraction_json: string | null;
  reconciliation_json: string | null;
  scanned_at: number;
}

/** A `chunks` row as SQLite returns it. */
interface ChunkRow {
  document_hash: string;
  chunk_index: number;
  page: number | null;
  text: string;
  embedding: Uint8Array;
}

/** A `labels` row as SQLite returns it. */
interface LabelRow {
  id: number;
  type: string;
  embedding: Uint8Array;
  provenance: string;
}

export interface OpenSqlcipherStorageOptions {
  /** Absolute path of the database file. */
  path: string;
  /** Supplies the raw key. Normally a `KeychainKeyProvider`. */
  keyProvider: DatabaseKeyProvider;
}

const DOCUMENT_TYPE_SET: ReadonlySet<string> = new Set<string>(DOCUMENT_TYPES);

/** Narrow a stored type string, so a corrupt row surfaces instead of being cast. */
function asDocumentType(value: string): DocumentType {
  if (!DOCUMENT_TYPE_SET.has(value)) {
    throw new StorageError(`Unknown document type in the store: ${value}.`);
  }
  return value as DocumentType;
}

/** Parse a stored JSON column, reporting which row and column failed. */
function parseJson<T>(json: string | null, what: string): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new StorageError(`Corrupt ${what} in the store: ${(error as Error).message}`);
  }
}

/** Apply every pending migration, each in its own transaction. */
function migrate(db: Db): void {
  const current = Number(readPragmaScalar(db.pragma('user_version')) ?? 0);
  for (const migration of pendingMigrations(current)) {
    const run = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
  }
}

/** Read the first bytes of the database file, or an empty view if it is shorter. */
async function readHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return Uint8Array.prototype.slice.call(buffer, 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Size of `path` in bytes, or 0 when it does not exist. */
async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Open (or create) the encrypted store.
 *
 * Failure modes, all of which reject rather than degrading:
 * - `DatabaseKeyError` if the key provider fails, or if it created a new key
 *   while a database already exists (the previous key is unrecoverable, so the
 *   store cannot be opened; the file is a derived cache and the fix is to
 *   delete it and re-scan).
 * - `DatabaseKeyError` if the key does not decrypt an existing database.
 * - `StorageFormatError` if the cipher configuration or the bytes on disk are
 *   not the upstream-compatible SQLCipher format ADR-0011 committed to.
 * - `StorageMigrationError` if the schema is newer than this build understands.
 * - Whatever the filesystem raises if the data directory cannot be created
 *   owner-only.
 *
 * Never falls back to an unencrypted database. The database handle is closed
 * before any of these reject, so a failed open leaks nothing.
 */
export async function openSqlcipherStorage(
  options: OpenSqlcipherStorageOptions,
): Promise<SqlcipherStorage> {
  const { path, keyProvider } = options;
  await ensureAppDataDir(dirname(path));

  const existingSize = await fileSize(path);
  const { key, created } = await keyProvider.getOrCreateKey();
  if (created && existingSize > 0) {
    throw new DatabaseKeyError(
      `A database exists at ${path} but its key does not, so a new one was generated and ` +
        'nothing can decrypt the old file. Outtray will not overwrite it. The store is a ' +
        'derived cache and your documents are untouched: delete the file and re-scan.',
    );
  }

  const db: Db = new Database(path);
  try {
    for (const pragma of CIPHER_PRAGMAS) db.pragma(pragma);
    db.pragma(`key = "x'${key.toString('hex')}'"`);

    // Proves the key: pragmas above succeed regardless, the first page read does not.
    try {
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    } catch (error) {
      throw new DatabaseKeyError(
        `The database key does not open ${path} (${(error as Error).message}). If the Keychain ` +
          'item was replaced, the file cannot be recovered; delete it and re-scan.',
      );
    }

    assertCipherPragmas((pragma) => db.pragma(pragma));
    db.pragma('foreign_keys = ON');
    migrate(db);

    await chmod(path, DATABASE_FILE_MODE);
    assertEncryptedHeader(await readHeader(path));
    return new SqlcipherStorage(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The encrypted SQLite store. Construct it with `openSqlcipherStorage`. */
export class SqlcipherStorage implements StorageProvider {
  readonly name = 'sqlcipher';
  readonly #db: Db;
  #closed = false;

  /** @internal Use `openSqlcipherStorage`, which configures and asserts the format. */
  constructor(db: Db) {
    this.#db = db;
  }

  /** The schema version this store was migrated to. */
  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  #open(): Db {
    if (this.#closed) throw new StorageError('Storage is closed.');
    return this.#db;
  }

  async putDocument(document: StoredDocument): Promise<void> {
    const db = this.#open();
    db.prepare(
      `INSERT INTO documents
         (content_hash, path, type, extraction_json, reconciliation_json, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(content_hash) DO UPDATE SET
         path = excluded.path,
         type = excluded.type,
         extraction_json = excluded.extraction_json,
         reconciliation_json = excluded.reconciliation_json,
         scanned_at = excluded.scanned_at`,
    ).run(
      document.contentHash,
      document.path,
      document.type,
      document.extraction === null ? null : JSON.stringify(document.extraction),
      document.reconciliation === null ? null : JSON.stringify(document.reconciliation),
      document.scannedAt,
    );
  }

  async getDocument(contentHash: string): Promise<StoredDocument | null> {
    const db = this.#open();
    const row = db.prepare('SELECT * FROM documents WHERE content_hash = ?').get(contentHash) as
      | DocumentRow
      | undefined;
    return row ? toDocument(row) : null;
  }

  async listDocuments(): Promise<StoredDocument[]> {
    const db = this.#open();
    const rows = db.prepare('SELECT * FROM documents ORDER BY content_hash').all() as DocumentRow[];
    return rows.map(toDocument);
  }

  async deleteDocument(contentHash: string): Promise<void> {
    const db = this.#open();
    db.prepare('DELETE FROM documents WHERE content_hash = ?').run(contentHash);
  }

  async putChunks(contentHash: string, chunks: StoredChunk[]): Promise<void> {
    const db = this.#open();
    assertChunkBatch(contentHash, chunks);
    const exists = db
      .prepare('SELECT 1 AS present FROM documents WHERE content_hash = ?')
      .get(contentHash);
    if (!exists) {
      throw new StorageError(`No document ${contentHash} to attach chunks to.`);
    }
    // Encode before the transaction so a bad vector rejects without writing.
    const encoded = chunks.map((chunk) => ({ chunk, embedding: encodeEmbedding(chunk.embedding) }));
    const insert = db.prepare(
      'INSERT INTO chunks (document_hash, chunk_index, page, text, embedding) VALUES (?, ?, ?, ?, ?)',
    );
    const replace = db.transaction(() => {
      db.prepare('DELETE FROM chunks WHERE document_hash = ?').run(contentHash);
      for (const { chunk, embedding } of encoded) {
        insert.run(contentHash, chunk.chunkIndex, chunk.page, chunk.text, embedding);
      }
    });
    replace();
  }

  async listChunks(): Promise<StoredChunk[]> {
    const db = this.#open();
    const rows = db
      .prepare('SELECT * FROM chunks ORDER BY document_hash, chunk_index')
      .all() as ChunkRow[];
    return rows.map((row) => ({
      documentHash: row.document_hash,
      chunkIndex: row.chunk_index,
      page: row.page,
      text: row.text,
      embedding: decodeEmbedding(row.embedding),
    }));
  }

  async addLabels(labels: NewLabel[]): Promise<StoredLabel[]> {
    const db = this.#open();
    if (labels.length === 0) return [];
    const encoded = labels.map((label) => ({
      label,
      provenance: asLabelProvenance(label.provenance),
      embedding: encodeEmbedding(label.embedding),
    }));
    const insert = db.prepare(
      'INSERT INTO labels (type, embedding, provenance) VALUES (?, ?, ?) RETURNING id',
    );
    const insertAll = db.transaction(() =>
      encoded.map(({ label, provenance, embedding }) => {
        const { id } = insert.get(label.type, embedding, provenance) as { id: number };
        return { ...label, id };
      }),
    );
    return insertAll();
  }

  async listLabels(): Promise<StoredLabel[]> {
    const db = this.#open();
    const rows = db.prepare('SELECT * FROM labels ORDER BY id').all() as LabelRow[];
    return rows.map((row) => ({
      id: row.id,
      type: asDocumentType(row.type),
      embedding: decodeEmbedding(row.embedding),
      provenance: asLabelProvenance(row.provenance),
    }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

/** Map a `documents` row to the domain record. */
function toDocument(row: DocumentRow): StoredDocument {
  return {
    contentHash: row.content_hash,
    path: row.path,
    type: row.type === null ? null : asDocumentType(row.type),
    extraction: parseJson<DocumentExtraction>(row.extraction_json, 'extraction JSON'),
    reconciliation: parseJson<Reconciliation>(row.reconciliation_json, 'reconciliation JSON'),
    scannedAt: row.scanned_at,
  };
}
