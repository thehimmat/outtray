/**
 * One suite, both implementations (ADR-0011).
 *
 * The in-memory store is only useful if it behaves like the real one, so the
 * contract is written once and run against both. When they drift, this fails
 * rather than the consumers that trusted the fake.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDatabaseKey, StaticKeyProvider } from './db-key.js';
import type { IdentifierField } from './identifiers.js';
import { openCommandStorage, type StorageTransport } from './storage-command.js';
import { DatabaseKeyError } from './storage-errors.js';
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

/**
 * The Rust store (packages/app/store) over a stdio pipe: the same command
 * layer the desktop app calls through Tauri (ADR-0013). Built by
 * `cargo build --release` in packages/app/store; CI sets
 * OUTTRAY_REQUIRE_RUST_STORE so a missing binary fails rather than skips.
 */
const RUST_STORE_BIN =
  process.env.OUTTRAY_STORE_BIN ??
  fileURLToPath(new URL('../../app/store/target/release/outtray-store-stdio', import.meta.url));
const rustStoreBuilt = existsSync(RUST_STORE_BIN);
if (!rustStoreBuilt && process.env.OUTTRAY_REQUIRE_RUST_STORE) {
  throw new Error(`OUTTRAY_REQUIRE_RUST_STORE is set but ${RUST_STORE_BIN} is not built.`);
}

/** A transport that speaks the stdio protocol of `outtray-store-stdio`. */
function stdioTransport(): StorageTransport {
  const child = spawn(RUST_STORE_BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  cleanups.push(async () => {
    child.kill();
  });
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line) as { id: number; ok?: unknown; error?: unknown };
    const waiter = pending.get(response.id);
    pending.delete(response.id);
    if ('error' in response) waiter?.reject(response.error);
    else waiter?.resolve(response.ok);
  });
  let next = 0;
  return (op, args) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
}

async function rustStore(keyHex = generateDatabaseKey().toString('hex'), path?: string) {
  let at = path;
  if (!at) {
    const dir = await mkdtemp(join(tmpdir(), 'outtray-rust-store-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    at = join(dir, 'outtray.db');
  }
  return openCommandStorage(stdioTransport(), { path: at, keyHex });
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
    extractorKey: 'qwen3-vl:2b|extract-v1|extract-typed-v1',
    indexKey: 'nomic-embed-text|chunk-v1|tokenize-v1',
    userType: null,
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
  documentHash: null,
  text: null,
  embedModel: 'nomic-embed-text',
  ...overrides,
});

const STORES: Array<[string, () => Promise<StorageProvider>]> = [
  ['MemoryStorage', memoryStore],
  ['SqlcipherStorage', sqlcipherStore],
];
if (rustStoreBuilt) STORES.push(['CommandStorage over the Rust store', () => rustStore()]);

describe.each(STORES)('%s (StorageProvider contract)', (_name, create) => {
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

  it('round-trips a correction with its document, tokenized text and embedding model', async () => {
    const store = await create();
    await store.addLabels([
      label({
        type: 'statement',
        provenance: 'correction',
        documentHash: 'hash-b',
        text: 'account_number: [account_number]',
        embedModel: null,
        embedding: [],
      }),
    ]);
    expect(await store.listLabels()).toMatchObject([
      {
        type: 'statement',
        documentHash: 'hash-b',
        text: 'account_number: [account_number]',
        embedModel: null,
        embedding: [],
      },
    ]);
    await store.close();
  });

  it("replaces one document's labels atomically, leaving seeds and other documents", async () => {
    const store = await create();
    await store.addLabels([
      label(),
      label({ provenance: 'correction', documentHash: 'hash-a', type: 'receipt' }),
      label({ provenance: 'correction', documentHash: 'hash-b', type: 'bill' }),
    ]);
    await store.replaceDocumentLabels('hash-b', [
      label({ provenance: 'correction', documentHash: 'hash-b', type: 'statement' }),
    ]);
    expect((await store.listLabels()).map((l) => [l.documentHash, l.type])).toEqual([
      [null, 'bill'],
      ['hash-a', 'receipt'],
      ['hash-b', 'statement'],
    ]);
    await store.replaceDocumentLabels('hash-b', []);
    expect(await store.listLabels()).toHaveLength(2);
    await store.close();
  });

  it('refuses a replacement label that belongs to another document, writing nothing', async () => {
    const store = await create();
    await store.addLabels([label({ provenance: 'correction', documentHash: 'hash-b' })]);
    await expect(
      store.replaceDocumentLabels('hash-b', [
        label({ provenance: 'correction', documentHash: 'hash-z' }),
      ]),
    ).rejects.toThrow(StorageError);
    expect(await store.listLabels()).toHaveLength(1);
    await store.close();
  });

  it('updates one label embedding and its model, and rejects an unknown id', async () => {
    const store = await create();
    const [added] = await store.addLabels([label({ embedModel: null, embedding: [] })]);
    await store.updateLabelEmbedding(added?.id ?? 0, [0.5, 0.5], 'nomic-embed-text');
    expect(await store.listLabels()).toMatchObject([
      { embedding: [0.5, 0.5], embedModel: 'nomic-embed-text' },
    ]);
    await expect(store.updateLabelEmbedding(999, [1], 'm')).rejects.toThrow(StorageError);
    await store.close();
  });

  it('round-trips the type a user pinned on a document', async () => {
    const store = await create();
    await store.putDocument(document({ userType: 'statement' }));
    expect(await store.getDocument('hash-b')).toMatchObject({ userType: 'statement' });
    await store.close();
  });

  it('rejects an unknown label provenance', async () => {
    const store = await create();
    await expect(
      store.addLabels([{ ...label(), provenance: 'guessed' } as unknown as NewLabel]),
    ).rejects.toThrow(StorageError);
    await store.close();
  });

  it('vaults an identifier and reveals it by document and field', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'X1234567' }]);
    expect(await store.getIdentifier('hash-b', 'id_number')).toBe('X1234567');
    expect(await store.countIdentifiers()).toBe(1);
    await store.close();
  });

  it('resolves null for a document or field with no vaulted identifier', async () => {
    const store = await create();
    await store.putDocument(document());
    expect(await store.getIdentifier('hash-b', 'id_number')).toBeNull();
    expect(await store.getIdentifier('missing', 'account_number')).toBeNull();
    await store.close();
  });

  it('stores a number mentioned by several documents once, whatever its formatting', async () => {
    const store = await create();
    await store.putDocument(document({ contentHash: 'hash-a' }));
    await store.putDocument(document({ contentHash: 'hash-b' }));
    await store.putDocument(document({ contentHash: 'hash-c' }));
    await store.putIdentifiers('hash-a', [{ field: 'id_number', value: 'X1234567' }]);
    await store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'x-123 4567' }]);
    await store.putIdentifiers('hash-c', [{ field: 'account_number', value: 'X1234567' }]);
    expect(await store.countIdentifiers()).toBe(1);
    expect(await store.getIdentifier('hash-b', 'id_number')).toBe('X1234567');
    expect(await store.getIdentifier('hash-c', 'account_number')).toBe('X1234567');
    await store.close();
  });

  it('keeps an identifier while any document still mentions it', async () => {
    const store = await create();
    await store.putDocument(document({ contentHash: 'hash-a' }));
    await store.putDocument(document({ contentHash: 'hash-b' }));
    await store.putIdentifiers('hash-a', [{ field: 'id_number', value: 'X1234567' }]);
    await store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'X1234567' }]);
    await store.deleteDocument('hash-a');
    expect(await store.countIdentifiers()).toBe(1);
    await store.deleteDocument('hash-b');
    expect(await store.countIdentifiers()).toBe(0);
    await store.close();
  });

  it('replaces a document identifier and drops the one no longer mentioned', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'X1234567' }]);
    await store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'Y7654321' }]);
    expect(await store.getIdentifier('hash-b', 'id_number')).toBe('Y7654321');
    expect(await store.countIdentifiers()).toBe(1);
    await store.close();
  });

  it('clears a document identifiers with an empty batch', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'X1234567' }]);
    await store.putIdentifiers('hash-b', []);
    expect(await store.getIdentifier('hash-b', 'id_number')).toBeNull();
    expect(await store.countIdentifiers()).toBe(0);
    await store.close();
  });

  it('drops a field the document no longer has when its identifiers are replaced', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putIdentifiers('hash-b', [{ field: 'policy_number', value: 'P99887766' }]);
    await store.putIdentifiers('hash-b', [{ field: 'account_number', value: 'A55443322' }]);
    expect(await store.getIdentifier('hash-b', 'policy_number')).toBeNull();
    expect(await store.getIdentifier('hash-b', 'account_number')).toBe('A55443322');
    expect(await store.countIdentifiers()).toBe(1);
    await store.close();
  });

  it('refuses a batch naming one field twice, writing nothing', async () => {
    const store = await create();
    await store.putDocument(document());
    await expect(
      store.putIdentifiers('hash-b', [
        { field: 'id_number', value: 'X1234567' },
        { field: 'id_number', value: 'Y7654321' },
      ]),
    ).rejects.toThrow(StorageError);
    expect(await store.countIdentifiers()).toBe(0);
    await store.close();
  });

  it('keeps identifiers when a document row is replaced by a re-scan', async () => {
    const store = await create();
    await store.putDocument(document());
    await store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'X1234567' }]);
    await store.putDocument(document({ path: '/moved/passport.png' }));
    expect(await store.getIdentifier('hash-b', 'id_number')).toBe('X1234567');
    await store.close();
  });

  it('purges every identifier and leaves documents alone', async () => {
    const store = await create();
    await store.putDocument(document({ contentHash: 'hash-a' }));
    await store.putDocument(document({ contentHash: 'hash-b' }));
    await store.putIdentifiers('hash-a', [{ field: 'id_number', value: 'X1234567' }]);
    await store.putIdentifiers('hash-b', [{ field: 'policy_number', value: 'P99887766' }]);
    expect(await store.purgeIdentifiers()).toBe(2);
    expect(await store.countIdentifiers()).toBe(0);
    expect(await store.getIdentifier('hash-a', 'id_number')).toBeNull();
    expect(await store.listDocuments()).toHaveLength(2);
    expect(await store.purgeIdentifiers()).toBe(0);
    await store.close();
  });

  it('refuses to vault for a missing document, a blank value, or an unknown field', async () => {
    const store = await create();
    await store.putDocument(document());
    await expect(
      store.putIdentifiers('missing', [{ field: 'id_number', value: 'X1234567' }]),
    ).rejects.toThrow(StorageError);
    await expect(
      store.putIdentifiers('hash-b', [{ field: 'id_number', value: ' - ' }]),
    ).rejects.toThrow(StorageError);
    await expect(
      store.putIdentifiers('hash-b', [
        { field: 'holder_name' as IdentifierField, value: 'X1234567' },
      ]),
    ).rejects.toThrow(StorageError);
    expect(await store.countIdentifiers()).toBe(0);
    await store.close();
  });

  it('lists which identifier fields a document has vaulted, never the values', async () => {
    const store = await create();
    await store.putDocument(document());
    expect(await store.identifierFields('hash-b')).toEqual([]);
    await store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'X1234567' }]);
    expect(await store.identifierFields('hash-b')).toEqual(['id_number']);
    expect(await store.identifierFields('missing')).toEqual([]);
    await store.purgeIdentifiers();
    expect(await store.identifierFields('hash-b')).toEqual([]);
    await store.close();
  });

  it('round-trips null version keys for a document never indexed', async () => {
    const store = await create();
    await store.putDocument(document({ extractorKey: null, indexKey: null }));
    expect(await store.getDocument('hash-b')).toMatchObject({ extractorKey: null, indexKey: null });
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
    await expect(
      store.putIdentifiers('hash-b', [{ field: 'id_number', value: 'X1234567' }]),
    ).rejects.toThrow(StorageError);
    await expect(store.getIdentifier('hash-b', 'id_number')).rejects.toThrow(StorageError);
    await expect(store.purgeIdentifiers()).rejects.toThrow(StorageError);
    await expect(store.countIdentifiers()).rejects.toThrow(StorageError);
    await expect(store.identifierFields('hash-b')).rejects.toThrow(StorageError);
    await expect(store.replaceDocumentLabels('hash-b', [])).rejects.toThrow(StorageError);
    await expect(store.updateLabelEmbedding(1, [1], 'm')).rejects.toThrow(StorageError);
  });
});

describe.runIf(rustStoreBuilt)('one file, two stores (ADR-0013)', () => {
  it('the Rust store reads what the Node store wrote, and the reverse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outtray-both-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'outtray.db');
    const key = generateDatabaseKey();

    const node = await openSqlcipherStorage({ path, keyProvider: new StaticKeyProvider(key) });
    await node.putDocument(document());
    await node.putChunks('hash-b', [chunk()]);
    await node.putIdentifiers('hash-b', [{ field: 'id_number', value: 'X1234567' }]);
    await node.close();

    const rust = await rustStore(key.toString('hex'), path);
    expect(await rust.getDocument('hash-b')).toEqual(document());
    expect(await rust.listChunks()).toEqual([chunk()]);
    expect(await rust.getIdentifier('hash-b', 'id_number')).toBe('X1234567');
    await rust.addLabels([label({ provenance: 'correction', documentHash: 'hash-b' })]);
    await rust.close();

    const again = await openSqlcipherStorage({ path, keyProvider: new StaticKeyProvider(key) });
    expect(await again.listLabels()).toMatchObject([
      { provenance: 'correction', documentHash: 'hash-b' },
    ]);
    await again.close();
  });

  it('a wrong key from the Rust side is a key error, like the Node side', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outtray-both-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'outtray.db');
    const node = await openSqlcipherStorage({
      path,
      keyProvider: new StaticKeyProvider(generateDatabaseKey()),
    });
    await node.close();
    await expect(rustStore(generateDatabaseKey().toString('hex'), path)).rejects.toThrow(
      DatabaseKeyError,
    );
  });
});
