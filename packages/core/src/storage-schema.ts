/**
 * Schema, migrations and row codecs for the encrypted store (ADR-0011).
 *
 * Migrations are an ordered, append-only list applied against SQLite's
 * `user_version`. Ordinary SQLite practice, and the cheapest mechanism that
 * still refuses to guess: a database written by a newer Outtray is rejected
 * rather than opened and quietly half-understood, because the file is a derived
 * cache and telling the user to re-scan is always available.
 *
 * The selection of what is pending is pure and tested on its own; applying it
 * needs a real database and is tested through the adapter.
 */

/** One schema step. Versions are contiguous from 1 and never edited once shipped. */
export interface Migration {
  version: number;
  /** Human-readable, for errors and for reading the history. */
  name: string;
  /** Statements applied in one transaction. */
  statements: readonly string[];
}

/**
 * Migration 1: the three tables ADR-0011 names, plus the identifier tables its
 * section 3 describes.
 *
 * The identifier tables are created here and filled by the identifier vault
 * work (#79): one canonical row per normalized value, referenced by every
 * document that mentions it, so a purge has one place to purge and a reveal
 * gate has something to gate. They stay empty unless the user turns identifier
 * storage on, which is off by default.
 *
 * Embeddings are float32 BLOBs, matching what the spike measured. Foreign keys
 * are declared, and the adapter turns `PRAGMA foreign_keys` on per connection
 * (SQLite defaults it off), so a chunk cannot outlive its document.
 */
const MIGRATION_1: Migration = {
  version: 1,
  name: 'initial-schema',
  statements: [
    `CREATE TABLE documents (
      content_hash        TEXT PRIMARY KEY,
      path                TEXT NOT NULL,
      type                TEXT,
      extraction_json     TEXT,
      reconciliation_json TEXT,
      scanned_at          INTEGER NOT NULL
    )`,
    `CREATE TABLE chunks (
      document_hash TEXT    NOT NULL REFERENCES documents(content_hash) ON DELETE CASCADE,
      chunk_index   INTEGER NOT NULL,
      page          INTEGER,
      text          TEXT    NOT NULL,
      embedding     BLOB    NOT NULL,
      PRIMARY KEY (document_hash, chunk_index)
    )`,
    `CREATE TABLE labels (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,
      embedding  BLOB NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('seed', 'correction'))
    )`,
    // One canonical row per identifier value (ADR-0011 section 3, #79).
    `CREATE TABLE identifiers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_value TEXT    NOT NULL UNIQUE,
      value            TEXT    NOT NULL,
      last_four        TEXT    NOT NULL,
      value_length     INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    )`,
    // Which documents mention which identifier, and as which extracted field.
    `CREATE TABLE identifier_mentions (
      identifier_id INTEGER NOT NULL REFERENCES identifiers(id) ON DELETE CASCADE,
      document_hash TEXT    NOT NULL REFERENCES documents(content_hash) ON DELETE CASCADE,
      field         TEXT    NOT NULL,
      PRIMARY KEY (identifier_id, document_hash, field)
    )`,
  ],
};

/** Every migration, in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_1];

/** Schema version a store is brought up to at open time. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Thrown when the schema on disk cannot be brought to `SCHEMA_VERSION`. */
export class StorageMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageMigrationError';
  }
}

/**
 * The migrations that still need applying to a database at `currentVersion`.
 *
 * Failure modes: throws `StorageMigrationError` if `currentVersion` is beyond
 * the newest known migration, which means an older Outtray opened a newer
 * database; the store is a derived cache, so the honest answer is to refuse
 * rather than to downgrade a schema in place. Also throws if the migration list
 * itself is not contiguous from 1, which is a programming error caught at open
 * time rather than at the moment a step is skipped. Pure.
 */
export function pendingMigrations(
  currentVersion: number,
  migrations: readonly Migration[] = MIGRATIONS,
): readonly Migration[] {
  migrations.forEach((migration, i) => {
    if (migration.version !== i + 1) {
      throw new StorageMigrationError(
        `Migrations must be contiguous from 1; found version ${migration.version} at position ${i}.`,
      );
    }
  });
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (currentVersion > latest) {
    throw new StorageMigrationError(
      `The database is at schema version ${currentVersion}, newer than this build understands ` +
        `(${latest}). Upgrade Outtray, or delete the store and re-scan; it is a derived cache.`,
    );
  }
  return migrations.filter((migration) => migration.version > currentVersion);
}

/**
 * Encode an embedding as a float32 BLOB.
 *
 * Failure modes: throws `RangeError` for a non-finite component, so a NaN
 * produced upstream is caught at the write rather than poisoning every later
 * cosine comparison. Accepts an empty vector.
 */
export function encodeEmbedding(embedding: readonly number[]): Buffer {
  const floats = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    const value = embedding[i] as number;
    if (!Number.isFinite(value)) {
      throw new RangeError(`Embedding component ${i} is not finite: ${value}.`);
    }
    floats[i] = value;
  }
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

/**
 * Decode a float32 BLOB back into an embedding.
 *
 * Values are float32-rounded relative to what was written; that is inherent to
 * the storage format and well below the resolution cosine ranking needs.
 *
 * Failure modes: throws `StorageMigrationError` if the BLOB length is not a
 * multiple of 4, which means the row is not a float32 vector.
 */
export function decodeEmbedding(blob: Uint8Array): number[] {
  if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new StorageMigrationError(
      `Embedding BLOB is ${blob.byteLength} bytes, not a whole number of float32 values.`,
    );
  }
  const copy = Uint8Array.prototype.slice.call(blob);
  return Array.from(
    new Float32Array(
      copy.buffer,
      copy.byteOffset,
      copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
    ),
  );
}
