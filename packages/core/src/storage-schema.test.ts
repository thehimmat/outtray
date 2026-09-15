import { describe, expect, it } from 'vitest';
import {
  decodeEmbedding,
  encodeEmbedding,
  MIGRATIONS,
  type Migration,
  pendingMigrations,
  SCHEMA_VERSION,
  StorageMigrationError,
} from './storage-schema.js';

const migration = (version: number): Migration => ({
  version,
  name: `m${version}`,
  statements: ['SELECT 1'],
});

describe('MIGRATIONS', () => {
  it('is contiguous from 1 and ends at SCHEMA_VERSION', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('creates the tables ADR-0011 names, and the identifier tables it describes', () => {
    const sql = MIGRATIONS.flatMap((m) => m.statements).join('\n');
    for (const table of ['documents', 'chunks', 'labels', 'identifiers', 'identifier_mentions']) {
      expect(sql).toContain(`CREATE TABLE ${table} `);
    }
  });
});

describe('pendingMigrations', () => {
  it('returns everything for a database that has none', () => {
    expect(pendingMigrations(0, [migration(1), migration(2)])).toHaveLength(2);
  });

  it('returns only what comes after the current version', () => {
    expect(pendingMigrations(1, [migration(1), migration(2)]).map((m) => m.version)).toEqual([2]);
  });

  it('returns nothing for a database already at the latest version', () => {
    expect(pendingMigrations(2, [migration(1), migration(2)])).toEqual([]);
  });

  it('refuses a database from a newer build rather than downgrading it', () => {
    const fail = () => pendingMigrations(9, [migration(1)]);
    expect(fail).toThrow(StorageMigrationError);
    expect(fail).toThrow(/re-scan/);
  });

  it('catches a migration list with a gap, at open time', () => {
    expect(() => pendingMigrations(0, [migration(1), migration(3)])).toThrow(StorageMigrationError);
  });
});

describe('encodeEmbedding and decodeEmbedding', () => {
  it('round-trips exactly representable values', () => {
    expect(decodeEmbedding(encodeEmbedding([0.5, -0.25, 0, 1]))).toEqual([0.5, -0.25, 0, 1]);
  });

  it('round-trips other values within float32 precision', () => {
    const values = [0.1, -0.7, 1 / 3];
    decodeEmbedding(encodeEmbedding(values)).forEach((value, i) => {
      expect(value).toBeCloseTo(values[i] as number, 6);
    });
  });

  it('handles an empty vector', () => {
    expect(decodeEmbedding(encodeEmbedding([]))).toEqual([]);
  });

  it('writes four bytes per component', () => {
    expect(encodeEmbedding([1, 2, 3]).byteLength).toBe(12);
  });

  it('refuses a non-finite component rather than storing a poisoned vector', () => {
    expect(() => encodeEmbedding([1, Number.NaN])).toThrow(RangeError);
    expect(() => encodeEmbedding([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });

  it('refuses a BLOB that is not a whole number of float32 values', () => {
    expect(() => decodeEmbedding(new Uint8Array(6))).toThrow(StorageMigrationError);
  });

  it('decodes a BLOB that is not aligned in its backing buffer', () => {
    // SQLite hands back views into a larger buffer; a naive Float32Array
    // constructor over one throws on a non-multiple-of-4 byte offset.
    const backing = new Uint8Array(13);
    backing.set(encodeEmbedding([1, 2, 3]), 1);
    expect(decodeEmbedding(backing.subarray(1))).toEqual([1, 2, 3]);
  });
});
