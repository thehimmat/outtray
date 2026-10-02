import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentExtraction } from './extraction-schema.js';
import { persistScan, setIdentifierStorage } from './persist.js';
import type { Reconciliation } from './reconcile.js';
import type { ScanItem, ScanReport } from './scan.js';
import { readSettings } from './settings.js';
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
      dir: 'pile',
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
    });
  });

  it('stores a failed extraction with no type, extraction or verdict', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('bad.png', null)]), {
      dir: 'pile',
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
        dir: 'pile',
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
      dir: 'pile',
      identifierStorage: false,
    });
    expect(await store.countIdentifiers()).toBe(0);
    expect(summary).toEqual({ documents: 1, identifiersVaulted: 0, identifiersPurged: 0 });
  });

  it('purges a leftover vault when identifier storage is off', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('passport.png', PASSPORT)]), {
      dir: 'pile',
      identifierStorage: true,
    });
    const summary = await persistScan(store, report([item('bill.png', BILL)]), {
      dir: 'pile',
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
      { dir: 'pile', identifierStorage: true },
    );
    expect(await store.getIdentifier('hash-passport.png', 'id_number')).toBe('AB1234567');
    expect(summary).toEqual({ documents: 2, identifiersVaulted: 1, identifiersPurged: 0 });
  });

  it('clears a vaulted value the document no longer carries on a re-scan', async () => {
    const store = new MemoryStorage();
    await persistScan(store, report([item('passport.png', PASSPORT)]), {
      dir: 'pile',
      identifierStorage: true,
    });
    await persistScan(store, report([item('passport.png', null)]), {
      dir: 'pile',
      identifierStorage: true,
    });
    expect(await store.getIdentifier('hash-passport.png', 'id_number')).toBeNull();
    expect(await store.countIdentifiers()).toBe(0);
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
      dir: 'pile',
      identifierStorage: true,
    });
    expect(await setIdentifierStorage({ configPath, storage: store, enabled: false })).toEqual({
      purged: 1,
    });
    expect((await readSettings(configPath)).settings.identifierStorage).toBe(false);
    expect(await store.countIdentifiers()).toBe(0);
    expect(await store.listDocuments()).toHaveLength(1);
  });
});
