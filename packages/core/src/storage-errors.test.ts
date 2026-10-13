import { describe, expect, it } from 'vitest';
import { DatabaseKeyError } from './db-key.js';
import { explainStorageError, StorageCorruptError } from './storage-errors.js';

const sqliteError = (code: string, message = 'sqlite says no') =>
  Object.assign(new Error(message), { code });

describe('explainStorageError', () => {
  it.each(['SQLITE_CORRUPT', 'SQLITE_CORRUPT_INDEX', 'SQLITE_NOTADB'])(
    'turns %s into the recoverable truth, naming the file',
    (code) => {
      const text = explainStorageError(sqliteError(code), '/data/outtray.db');
      expect(text).toMatch(/\/data\/outtray\.db is damaged/);
      expect(text).toMatch(/your documents are untouched/);
      expect(text).toMatch(/delete it and re-scan/);
    },
  );

  it('says another command holds the store when it is locked', () => {
    expect(explainStorageError(sqliteError('SQLITE_BUSY'), '/data/outtray.db')).toMatch(
      /Another Outtray command is using the store; try again when it finishes/,
    );
  });

  it('passes a StorageCorruptError message through', () => {
    expect(
      explainStorageError(new StorageCorruptError('/data/outtray.db', 'cut off'), '/x'),
    ).toMatch(/\/data\/outtray\.db is damaged \(cut off\)/);
  });

  it('leaves other errors as their own message', () => {
    expect(explainStorageError(new DatabaseKeyError('Keychain locked'), '/x')).toBe(
      'Keychain locked',
    );
    expect(explainStorageError('plain string', '/x')).toBe('plain string');
  });
});
