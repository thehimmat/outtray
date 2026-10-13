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

import migrationsJson from './migrations.json' with { type: 'json' };

/** One schema step. Versions are contiguous from 1 and never edited once shipped. */
export interface Migration {
  version: number;
  /** Human-readable, for errors and for reading the history. */
  name: string;
  /** What the step is for, in one or two sentences. */
  note?: string;
  /** Statements applied in one transaction. */
  statements: readonly string[];
}

/**
 * Every migration, in order. Append only.
 *
 * The list lives in `migrations.json` so that it is one source for both
 * stores: this TypeScript adapter imports it, and the Rust adapter the desktop
 * app uses embeds the same file (ADR-0013). Each entry's `note` says what the
 * step is for; the ADRs it names hold the reasoning.
 */
export const MIGRATIONS: readonly Migration[] = migrationsJson;

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
