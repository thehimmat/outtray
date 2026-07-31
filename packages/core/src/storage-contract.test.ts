/**
 * One suite, both implementations (ADR-0011).
 *
 * The in-memory store is only useful if it behaves like the real one, so the
 * contract is written once and run against both. When they drift, this fails
 * rather than the consumers that trusted the fake.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDatabaseKey, StaticKeyProvider } from './db-key.js';
import { MemoryStorage } from './storage-memory.js';
import {
  type NewLabel,
  StorageError,
  type StorageProvider,
  type StoredChunk,
  type StoredDocument,
} from './storage-provider.js';
import { openSqlcipherStorage } from './storage-sqlcipher.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function memoryStore(): Promise<StorageProvider> {
  return new MemoryStorage();
}

async function sqlcipherStore(): Promise<StorageProvider> {
  const dir = await mkdtemp(join(tmpdir(), 'outtray-store-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return openSqlcipherStorage({
    path: join(dir, 'outtray.db'),
    keyProvider: new StaticKeyProvider(generateDatabaseKey()),
  });
}

function document(overrides: Partial<StoredDocument> = {}): StoredDocument {
  return {
    contentHash: 'hash-b',
    path: '/docs/passport.png',
    type: 'id_document',
    extraction: {
      type: 'id_document',
      holder_name: 'A. Person',
      id_number: 'X1234567',
      issuer: 'HM Passport Office',
      expiry_date: '2027-03-01',
      summary: 'A passport expiring in 2027.',
      action_items: [{ text: 'Renew before travel', due_date: '2027-03-01' }],
    },
    reconciliation: {
      effectiveType: 'id_document',
      status: 'confirmed',
      review: false,
      vlmType: 'id_document',
      classification: null,
    },
    scannedAt: 1_753_000_000_000,
    ...overrides,
  };
}

function chunk(overrides: Partial<StoredChunk> = {}): StoredChunk {
  return {
    documentHash: 'hash-b',
    chunkIndex: 0,
    page: 1,
    text: 'Passport of A. Person, expires 2027-03-01.',
    embedding: [0.5, -0.25, 0.125],
    ...overrides,
  };
}

const label = (overrides: Partial<NewLabel> = {}): NewLabel => ({
  type: 'bill',
  embedding: [0.25, 0.5],
  provenance: 'seed',
  ...overrides,
});

describe.each([
  ['MemoryStorage', memoryStore],
  ['SqlcipherStorage', sqlcipherStore],
])('%s (StorageProvider contract)', (_name, create) => {
  it('round-trips a document', async () => {
    const store = await create();
    const doc = document();
    await store.putDocument(doc);
    expect(await store.getDocument(doc.contentHash)).toEqual(doc);
    await store.close();
  });

  it('round-trips a document with no extraction and no verdict', async () => {
    const store = await create();
    const doc = document({ type: null, extraction: null, reconciliation: null });
    await store.putDocument(doc);
    expect(await store.getDocument(doc.contentHash)).toEqual(doc);
    await store.close();
  });

  it('resolves null for a document that is not there', async () => {
    const store = await create();
    expect(await store.getDocument('missing')).toBeNull();
    await store.close();
  });

  it('replaces a document with the same content hash rather than duplicating it', async () => {
    const store = await create();
    await store.putDocument(document({ path: '/old/passport.png' }));
    await store.putDocument(document({ path: '/new/passport.png' }));
    const all = await store.listDocuments();
    expect(all).toHaveLength(1);
    expect(all[0]?.path).toBe('/new/passport.png');
    await store.close();
  });

  it('lists documents ordered by content hash', async () => {
    const store = await create();
    await store.putDocument(document({ contentHash: 'hash-c' }));
    await store.putDocument(document({ contentHash: 'hash-a' }));
    await store.putDocument(document({ contentHash: 'hash-b' }));
    expect((await store.listDocuments()).map((d) => d.contentHash)).toEqual([
      'hash-a',
      'hash-b',
      'hash-c',
    ]);
    await store.close();
  });

  it('does not mutate what the caller handed it', async () => {
    const store = await create();
    const doc = document();
    await store.putDocument(doc);
    doc.path = '/moved.png';
    expect((await store.getDocument(doc.contentHash))?.path).toBe('/docs/passport.png');
    await store.close();
  });

  it('deletes a document and its chunks, and ignores a missing one', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putChunks('hash-b', [chunk()]);
    await store.deleteDocument('hash-b');
    expect(await store.getDocument('hash-b')).toBeNull();
    expect(await store.listChunks()).toEqual([]);
    await expect(store.deleteDocument('never-existed')).resolves.toBeUndefined();
    await store.close();
  });

  it('round-trips chunks in document then index order', async () => {
    const store = await create();
    await store.putDocument(document({ contentHash: 'hash-a' }));
    await store.putDocument(document({ contentHash: 'hash-b' }));
    await store.putChunks('hash-b', [
      chunk({ documentHash: 'hash-b', chunkIndex: 1, text: 'second' }),
      chunk({ documentHash: 'hash-b', chunkIndex: 0, text: 'first' }),
    ]);
    await store.putChunks('hash-a', [
      chunk({ documentHash: 'hash-a', chunkIndex: 0, text: 'other', page: null }),
    ]);
    const chunks = await store.listChunks();
    expect(chunks.map((c) => [c.documentHash, c.chunkIndex, c.text])).toEqual([
      ['hash-a', 0, 'other'],
      ['hash-b', 0, 'first'],
      ['hash-b', 1, 'second'],
    ]);
    expect(chunks[0]?.page).toBeNull();
    expect(chunks[1]?.embedding).toEqual([0.5, -0.25, 0.125]);
    await store.close();
  });

  it('replaces a document chunks rather than appending to them', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putChunks('hash-b', [chunk({ chunkIndex: 0 }), chunk({ chunkIndex: 1 })]);
    await store.putChunks('hash-b', [chunk({ chunkIndex: 0, text: 're-chunked' })]);
    const chunks = await store.listChunks();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('re-chunked');
    await store.close();
  });

  it('accepts an empty chunk batch as a way to clear a document', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putChunks('hash-b', [chunk()]);
    await store.putChunks('hash-b', []);
    expect(await store.listChunks()).toEqual([]);
    await store.close();
  });

  it('refuses chunks for a document that is not in the store', async () => {
    const store = await create();
    await expect(store.putChunks('hash-b', [chunk()])).rejects.toThrow(StorageError);
    await store.close();
  });

  it('refuses a chunk belonging to another document', async () => {
    const store = await create();
    await store.putDocument(document());
    await expect(store.putChunks('hash-b', [chunk({ documentHash: 'hash-z' })])).rejects.toThrow(
      StorageError,
    );
    await store.close();
  });

  it('refuses a batch with a duplicate chunk index, writing nothing', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putChunks('hash-b', [chunk({ chunkIndex: 0, text: 'kept' })]);
    await expect(
      store.putChunks('hash-b', [chunk({ chunkIndex: 3 }), chunk({ chunkIndex: 3 })]),
    ).rejects.toThrow(StorageError);
    expect((await store.listChunks())[0]?.text).toBe('kept');
    await store.close();
  });

  it('assigns increasing label ids and lists them in that order', async () => {
    const store = await create();
    const [seed] = await store.addLabels([label()]);
    const [correction] = await store.addLabels([
      label({ type: 'receipt', provenance: 'correction' }),
    ]);
    expect(seed?.id).toBeLessThan(correction?.id ?? 0);
    const listed = await store.listLabels();
    expect(listed.map((l) => [l.type, l.provenance])).toEqual([
      ['bill', 'seed'],
      ['receipt', 'correction'],
    ]);
    expect(listed[0]?.embedding).toEqual([0.25, 0.5]);
    await store.close();
  });

  it('appends duplicate labels rather than deduplicating them', async () => {
    const store = await create();
    await store.addLabels([label(), label()]);
    expect(await store.listLabels()).toHaveLength(2);
    await store.close();
  });

  it('returns an empty array for an empty label batch', async () => {
    const store = await create();
    expect(await store.addLabels([])).toEqual([]);
    await store.close();
  });

  it('rejects an unknown label provenance', async () => {
    const store = await create();
    await expect(
      store.addLabels([{ ...label(), provenance: 'guessed' } as unknown as NewLabel]),
    ).rejects.toThrow(StorageError);
    await store.close();
  });

  it('reports empty collections for a fresh store', async () => {
    const store = await create();
    expect(await store.listDocuments()).toEqual([]);
    expect(await store.listChunks()).toEqual([]);
    expect(await store.listLabels()).toEqual([]);
    await store.close();
  });

  it('rejects every operation after close, and tolerates closing twice', async () => {
    const store = await create();
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.listDocuments()).rejects.toThrow(StorageError);
    await expect(store.getDocument('hash-b')).rejects.toThrow(StorageError);
    await expect(store.putDocument(document())).rejects.toThrow(StorageError);
    await expect(store.listChunks()).rejects.toThrow(StorageError);
    await expect(store.listLabels()).rejects.toThrow(StorageError);
  });
});
