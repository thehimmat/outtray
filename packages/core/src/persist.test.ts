import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentExtraction } from './extraction-schema.js';
import { persistScan } from './persist.js';
import type { Reconciliation } from './reconcile.js';
import type { ScanItem, ScanReport } from './scan.js';
import { readSettings, setIdentifierStorage } from './settings.js';
import { MemoryStorage } from './storage-memory.js';

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };
const NOW = 1_780_000_000_000;

const PASSPORT: DocumentExtraction = {
  type: 'id_document',
  summary: 'Passport AB1234567 for Jane Doe.',
  action_items: [{ text: 'Renew AB 123 4567', due_date: '2027-01-01' }],
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

const confirmed = (type: DocumentExtraction['type']): Reconciliation => ({
  effectiveType: type,
  status: 'confirmed',
  review: false,
  vlmType: type,
  classification: { type, confidence: 0.7, votes: { [type]: 1 } },
});

const unclassified = (type: DocumentExtraction['type']): Reconciliation => ({
  effectiveType: type,
  status: 'unclassified',
  review: false,
  vlmType: type,
  classification: null,
});

function item(file: string, doc: DocumentExtraction | null, reconciliation?: Reconciliation) {
  const result = doc
    ? { valid: true as const, jsonChannel: 'content' as const, raw: doc, usage, error: null }
    : { valid: false as const, jsonChannel: null, raw: null, usage, error: 'no JSON' };
  return {
    file,
    contentHash: `hash-${file}`,
    result: { ...result, document: doc },
    reconciliation: reconciliation ?? (doc ? confirmed(doc.type) : unclassified('unknown')),
  } as ScanItem;
}

function report(items: ScanItem[]): ScanReport {
  return { scanned: items.map((i) => i.file), skipped: [], items, classifierError: null };
}

describe('persistScan', () => {
  it('stores each document by content hash with its path, type and verdict', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('bill.png', BILL)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
      now: NOW,
    });
    expect(await store.getDocument('hash-bill.png')).toEqual({
      contentHash: 'hash-bill.png',
      path: resolve('pile', 'bill.png'),
      type: 'bill',
      extraction: BILL,
      reconciliation: confirmed('bill'),
      scannedAt: NOW,
      extractorKey: null,
      indexKey: null,
      userType: null,
    });
  });

  it('stores a failed extraction with no type, extraction or verdict', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('bad.png', null)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
    });
    expect(await store.getDocument('hash-bad.png')).toMatchObject({
      type: null,
      extraction: null,
      reconciliation: null,
    });
  });

  it.each([false, true])(
    'stores only the redacted extraction, whatever the setting (on: %s)',
    async (identifierStorage) => {
      const store = new MemoryStorage();
      await persistScan(store, report([item('passport.png', PASSPORT)]), {
        locate: (f: string) => resolve('pile', f),
        identifierStorage,
      });
      const stored = JSON.stringify(await store.listDocuments());
      expect(stored).toContain('[id_number ending 4567, 9 chars]');
      expect(stored.replace(/[^A-Z0-9]/g, '')).not.toContain('AB1234567');
    },
  );

  it('vaults nothing when identifier storage is off', async () => {
    const store = new MemoryStorage();
    const summary = await persistScan(store, report([item('passport.png', PASSPORT)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
    });
    expect(await store.countIdentifiers()).toBe(0);
    expect(summary).toEqual({
      documents: 1,
      reused: 0,
      indexed: 0,
      identifiersVaulted: 0,
      identifiersPurged: 0,
    });
  });

  it('purges a leftover vault when identifier storage is off', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('passport.png', PASSPORT)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: true,
    });
    const summary = await persistScan(store, report([item('bill.png', BILL)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
    });
    expect(summary.identifiersPurged).toBe(1);
    expect(await store.countIdentifiers()).toBe(0);
  });

  it('vaults the full value when identifier storage is on', async () => {
    const store = new MemoryStorage();
    const summary = await persistScan(
      store,
      report([item('passport.png', PASSPORT), item('bill.png', BILL)]),
      { locate: (f: string) => resolve('pile', f), identifierStorage: true },
    );
    expect(await store.getIdentifier('hash-passport.png', 'id_number')).toBe('AB1234567');
    expect(summary).toEqual({
      documents: 2,
      reused: 0,
      indexed: 0,
      identifiersVaulted: 1,
      identifiersPurged: 0,
    });
  });

  it('clears a vaulted value the document no longer carries on a re-scan', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('passport.png', PASSPORT)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: true,
    });
    await persistScan(store, report([item('passport.png', null)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: true,
    });
    expect(await store.getIdentifier('hash-passport.png', 'id_number')).toBeNull();
    expect(await store.countIdentifiers()).toBe(0);
  });
});

describe('persistScan with the incremental index (ADR-0012)', () => {
  const EXTRACTOR = 'qwen3-vl:2b|extract-v1|extract-typed-v1';
  const INDEX = 'nomic-embed-text|chunk-v1|tokenize-v1';
  const chunkFor = (hash: string, text: string) => ({
    documentHash: hash,
    chunkIndex: 0,
    page: null,
    text,
    embedding: [1, 0],
  });

  it('writes chunks, then marks the document indexed under the key', async () => {
    const store = new MemoryStorage();
    const summary = await persistScan(store, report([item('bill.png', BILL)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
      extractorKey: EXTRACTOR,
      index: {
        key: INDEX,
        chunks: new Map([['hash-bill.png', [chunkFor('hash-bill.png', 'dmv')]]]),
      },
    });
    expect(await store.getDocument('hash-bill.png')).toMatchObject({
      extractorKey: EXTRACTOR,
      indexKey: INDEX,
      userType: null,
    });
    expect((await store.listChunks()).map((c) => c.text)).toEqual(['dmv']);
    expect(summary).toMatchObject({ documents: 1, indexed: 1, reused: 0 });
  });

  it('marks a document with no chunks indexed too, so it is not re-extracted forever', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('bill.png', BILL)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
      extractorKey: EXTRACTOR,
      index: { key: INDEX, chunks: new Map() },
    });
    expect(await store.getDocument('hash-bill.png')).toMatchObject({ indexKey: INDEX });
  });

  it('without an index, leaves the key null and clears chunks from an older extraction', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('bill.png', BILL)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
      extractorKey: EXTRACTOR,
      index: {
        key: INDEX,
        chunks: new Map([['hash-bill.png', [chunkFor('hash-bill.png', 'old')]]]),
      },
    });
    await persistScan(store, report([item('bill.png', BILL)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
      extractorKey: EXTRACTOR,
    });
    expect(await store.getDocument('hash-bill.png')).toMatchObject({ indexKey: null });
    expect(await store.listChunks()).toEqual([]);
  });

  it('never indexes a failed extraction', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('bad.png', null)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: false,
      extractorKey: EXTRACTOR,
      index: { key: INDEX, chunks: new Map() },
    });
    expect(await store.getDocument('hash-bad.png')).toMatchObject({ indexKey: null });
  });

  it('updates a reused document in place: new path, same keys and chunks, no re-redaction, vault untouched', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('passport.png', PASSPORT)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: true,
      extractorKey: EXTRACTOR,
      index: {
        key: INDEX,
        chunks: new Map([['hash-passport.png', [chunkFor('hash-passport.png', 'kept')]]]),
      },
    });
    const first = await store.getDocument('hash-passport.png');

    const again = item('moved.png', first?.extraction ?? null, first?.reconciliation ?? undefined);
    const summary = await persistScan(
      store,
      report([{ ...again, contentHash: 'hash-passport.png', reused: true }]),
      {
        locate: (f: string) => resolve('elsewhere', f),
        identifierStorage: true,
        extractorKey: EXTRACTOR,
        index: { key: INDEX, chunks: new Map() },
        now: NOW,
      },
    );
    expect(await store.getDocument('hash-passport.png')).toEqual({
      ...first,
      path: resolve('elsewhere', 'moved.png'),
      scannedAt: NOW,
    });
    expect((await store.listChunks()).map((c) => c.text)).toEqual(['kept']);
    expect(await store.getIdentifier('hash-passport.png', 'id_number')).toBe('AB1234567');
    expect(summary).toMatchObject({ documents: 1, reused: 1, indexed: 0, identifiersVaulted: 0 });
  });
});

describe('setIdentifierStorage', () => {
  let dir: string;
  let configPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'outtray-persist-'));
    configPath = join(dir, 'outtray', 'config.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('turning on records the choice and leaves the store alone', async () => {
    const store = new MemoryStorage();
    expect(await setIdentifierStorage({ configPath, storage: store, enabled: true })).toEqual({
      purged: 0,
    });
    expect((await readSettings(configPath)).settings.identifierStorage).toBe(true);
  });

  it('turning off records the choice and purges the vault', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('passport.png', PASSPORT)]), {
      locate: (f: string) => resolve('pile', f),
      identifierStorage: true,
    });
    expect(await setIdentifierStorage({ configPath, storage: store, enabled: false })).toEqual({
      purged: 1,
    });
    expect((await readSettings(configPath)).settings.identifierStorage).toBe(false);
    expect(await store.countIdentifiers()).toBe(0);
    expect(await store.listDocuments()).toHaveLength(1);
  });

  it('turning off with no store yet records the choice and purges nothing', async () => {
    await setIdentifierStorage({ configPath, storage: null, enabled: true });
    expect(await setIdentifierStorage({ configPath, storage: null, enabled: false })).toEqual({
      purged: 0,
    });
    expect((await readSettings(configPath)).settings.identifierStorage).toBe(false);
  });

  it('writes the setting before purging, so a failed purge leaves it off', async () => {
    const store = new MemoryStorage();
    store.purgeIdentifiers = async () => {
      throw new Error('disk full');
    };
    await expect(
      setIdentifierStorage({ configPath, storage: store, enabled: false }),
    ).rejects.toThrow('disk full');
    expect((await readSettings(configPath)).settings.identifierStorage).toBe(false);
  });
});
