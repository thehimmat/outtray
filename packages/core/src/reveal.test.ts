import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentExtraction } from './extraction-schema.js';
import { redactExtraction } from './identifiers.js';
import { isIdentifierField, locateDocument, revealIdentifier } from './reveal.js';
import { contentHashOf } from './scan.js';
import { MemoryStorage } from './storage-memory.js';
import type { StoredDocument } from './storage-provider.js';

const PASSPORT: DocumentExtraction = {
  type: 'id_document',
  summary: 'Passport AB1234567 for Jane Doe.',
  action_items: [],
  holder_name: 'Jane Doe',
  id_number: 'AB1234567',
  issuer: 'US Department of State',
  expiry_date: '2027-03-01',
};

const BILL: DocumentExtraction = {
  type: 'bill',
  summary: 'DMV renewal.',
  action_items: [],
  payee: 'State DMV',
  amount_due: '$301.00',
  due_date: '2026-08-31',
  late_fee: null,
};

function stored(contentHash: string, path: string, doc: DocumentExtraction | null): StoredDocument {
  return {
    contentHash,
    path,
    type: doc?.type ?? null,
    extraction: doc ? redactExtraction(doc) : null,
    reconciliation: null,
    scannedAt: 1,
  };
}

describe('isIdentifierField', () => {
  it('accepts the three identifier fields and nothing else', () => {
    expect(isIdentifierField('id_number')).toBe(true);
    expect(isIdentifierField('policy_number')).toBe(true);
    expect(isIdentifierField('account_number')).toBe(true);
    expect(isIdentifierField('holder_name')).toBe(false);
    expect(isIdentifierField('')).toBe(false);
  });
});

describe('locateDocument', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'outtray-reveal-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds a document by the hash of the file as it is now', async () => {
    const file = join(dir, 'passport.png');
    await writeFile(file, 'passport bytes');
    const hash = contentHashOf(Buffer.from('passport bytes'));
    const store = new MemoryStorage();
    // Stored under another path: a moved file is the same document.
    await store.putDocument(stored(hash, '/elsewhere/old-name.png', PASSPORT));
    expect((await locateDocument(store, file))?.contentHash).toBe(hash);
  });

  it('falls back to the stored path when the file is gone', async () => {
    const file = join(dir, 'gone.png');
    const store = new MemoryStorage();
    await store.putDocument(stored('hash-gone', file, PASSPORT));
    expect((await locateDocument(store, file))?.contentHash).toBe('hash-gone');
  });

  it('resolves a relative path before comparing with stored paths', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored('hash-rel', join(process.cwd(), 'no-such-file.png'), PASSPORT));
    expect((await locateDocument(store, 'no-such-file.png'))?.contentHash).toBe('hash-rel');
  });

  it('does not fall back to a stale row when the file exists but changed', async () => {
    const file = join(dir, 'passport.png');
    await writeFile(file, 'new bytes');
    const store = new MemoryStorage();
    await store.putDocument(stored('hash-of-old-bytes', file, PASSPORT));
    expect(await locateDocument(store, file)).toBeNull();
  });

  it('resolves null for a document never scanned', async () => {
    expect(await locateDocument(new MemoryStorage(), join(dir, 'nothing.png'))).toBeNull();
  });
});

describe('revealIdentifier', () => {
  it('returns the vaulted value for the named field', async () => {
    const store = new MemoryStorage();
    const doc = stored('h1', '/pile/passport.png', PASSPORT);
    await store.putDocument(doc);
    await store.putIdentifiers('h1', [{ field: 'id_number', value: 'AB1234567' }]);
    expect(await revealIdentifier(store, doc, 'id_number')).toEqual({
      status: 'revealed',
      field: 'id_number',
      value: 'AB1234567',
    });
  });

  it('says nothing is stored, with the redacted form, when the vault is empty', async () => {
    const store = new MemoryStorage();
    const doc = stored('h1', '/pile/passport.png', PASSPORT);
    await store.putDocument(doc);
    expect(await revealIdentifier(store, doc, 'id_number')).toEqual({
      status: 'not_stored',
      field: 'id_number',
      redacted: '[id_number ending 4567, 9 chars]',
    });
  });

  it('names the right field when asked for one the document does not carry', async () => {
    const store = new MemoryStorage();
    const doc = stored('h1', '/pile/passport.png', PASSPORT);
    await store.putDocument(doc);
    await store.putIdentifiers('h1', [{ field: 'id_number', value: 'AB1234567' }]);
    expect(await revealIdentifier(store, doc, 'policy_number')).toEqual({
      status: 'wrong_field',
      field: 'policy_number',
      documentField: 'id_number',
    });
  });

  it('reports a document type with no identifier field', async () => {
    const store = new MemoryStorage();
    const doc = stored('h2', '/pile/bill.png', BILL);
    await store.putDocument(doc);
    expect(await revealIdentifier(store, doc, 'account_number')).toEqual({
      status: 'wrong_field',
      field: 'account_number',
      documentField: null,
    });
  });

  it('reports a document whose extraction failed as having nothing stored', async () => {
    const store = new MemoryStorage();
    const doc = stored('h3', '/pile/blurry.png', null);
    await store.putDocument(doc);
    expect(await revealIdentifier(store, doc, 'id_number')).toEqual({
      status: 'not_stored',
      field: 'id_number',
      redacted: null,
    });
  });
});

describe('the reveal path stays the only reader of the vault', () => {
  it('no core module but the stores and reveal.ts calls getIdentifier', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const src = new URL('.', import.meta.url).pathname;
    const allowed = new Set(['reveal.ts', 'storage-memory.ts', 'storage-sqlcipher.ts']);
    const offenders: string[] = [];
    for (const name of await readdir(src)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || allowed.has(name)) continue;
      if ((await readFile(join(src, name), 'utf8')).includes('.getIdentifier(')) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
