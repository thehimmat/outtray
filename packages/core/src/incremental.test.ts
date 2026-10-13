import { describe, expect, it, vi } from 'vitest';
import { CHUNKER_VERSION } from './chunk.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { DocumentExtraction } from './extraction-schema.js';
import { redactExtraction, TOKENIZER_VERSION } from './identifiers.js';
import {
  buildIndex,
  extractorKeyFor,
  indexKeyFor,
  reusableDocument,
  reusedItem,
  searchStore,
} from './incremental.js';
import type { ScanItem, ScanReport } from './scan.js';
import { MemoryStorage } from './storage-memory.js';
import type { StoredDocument } from './storage-provider.js';

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };
const EXTRACTOR = 'qwen3-vl:2b|extract-v1|extract-typed-v1';
const INDEX = 'nomic-embed-text|chunk-v1|tokenize-v1';

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
  summary: 'DMV renewal, butter not included.',
  action_items: [],
  payee: 'State DMV',
  amount_due: '$301.00',
  due_date: '2026-08-31',
  late_fee: null,
};

function stored(overrides: Partial<StoredDocument> = {}): StoredDocument {
  return {
    contentHash: 'h-pass',
    path: '/pile/passport.png',
    type: 'id_document',
    extraction: redactExtraction(PASSPORT),
    reconciliation: null,
    scannedAt: 1,
    extractorKey: EXTRACTOR,
    indexKey: INDEX,
    ...overrides,
  };
}

function item(
  file: string,
  hash: string,
  doc: DocumentExtraction | null,
  reused = false,
): ScanItem {
  return {
    file,
    contentHash: hash,
    result: doc
      ? { valid: true, jsonChannel: 'content', raw: doc, usage, error: null, document: doc }
      : { valid: false, jsonChannel: null, raw: null, usage, error: 'no JSON', document: null },
    reconciliation: {
      effectiveType: doc?.type ?? 'unknown',
      status: 'unclassified',
      review: false,
      vlmType: doc?.type ?? null,
      classification: null,
    },
    ...(reused ? { reused: true as const } : {}),
  };
}

function report(items: ScanItem[]): ScanReport {
  return { scanned: items.map((i) => i.file), skipped: [], items, classifierError: null };
}

/** A deterministic embedder: counts of a few letters, so similar words rank close. */
function letterEmbedder(): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name: 'letters',
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) =>
        [...'abdeprt'].map((c) => t.toLowerCase().split(c).length - 1 + 0.01),
      );
    },
  };
}

describe('version keys', () => {
  it('extractor key names the model and both prompt versions', () => {
    expect(extractorKeyFor('qwen3-vl:2b')).toBe(EXTRACTOR);
  });

  it('index key names the embedding model, chunker and tokenizer versions', () => {
    expect(indexKeyFor('nomic-embed-text')).toBe(
      `nomic-embed-text|${CHUNKER_VERSION}|${TOKENIZER_VERSION}`,
    );
  });
});

describe('reusableDocument', () => {
  const keys = { extractorKey: EXTRACTOR, indexKey: INDEX, identifierStorage: false };

  it('reuses a stored document whose keys both match', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    expect((await reusableDocument(store, 'h-pass', keys))?.contentHash).toBe('h-pass');
  });

  it('does not reuse what is not stored', async () => {
    expect(await reusableDocument(new MemoryStorage(), 'h-pass', keys)).toBeNull();
  });

  it('retries a stored failed extraction', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored({ extraction: null, type: null }));
    expect(await reusableDocument(store, 'h-pass', keys)).toBeNull();
  });

  it('re-extracts when the model or prompts changed', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored({ extractorKey: 'qwen3-vl:4b|extract-v1|extract-typed-v1' }));
    expect(await reusableDocument(store, 'h-pass', keys)).toBeNull();
  });

  it('re-extracts when the document was never indexed or indexed differently', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored({ indexKey: null }));
    expect(await reusableDocument(store, 'h-pass', keys)).toBeNull();
    await store.putDocument(stored({ indexKey: 'other-embed|chunk-v1|tokenize-v1' }));
    expect(await reusableDocument(store, 'h-pass', keys)).toBeNull();
  });

  it('with identifier storage on, re-extracts a document whose identifier is not vaulted', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    const on = { ...keys, identifierStorage: true };
    expect(await reusableDocument(store, 'h-pass', on)).toBeNull();
    await store.putIdentifiers('h-pass', [{ field: 'id_number', value: 'AB1234567' }]);
    expect((await reusableDocument(store, 'h-pass', on))?.contentHash).toBe('h-pass');
  });

  it('with identifier storage on, reuses a document type that has no identifier', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored({ contentHash: 'h-bill', type: 'bill', extraction: BILL }));
    expect(
      await reusableDocument(store, 'h-bill', { ...keys, identifierStorage: true }),
    ).not.toBeNull();
  });
});

describe('reusedItem', () => {
  it('rebuilds a scan item from a stored document, marked reused', () => {
    const verdict = {
      effectiveType: 'id_document' as const,
      status: 'confirmed' as const,
      review: false,
      vlmType: 'id_document' as const,
      classification: null,
    };
    const built = reusedItem('passport.png', stored({ reconciliation: verdict }));
    expect(built).toMatchObject({
      file: 'passport.png',
      contentHash: 'h-pass',
      reused: true,
      reconciliation: verdict,
      result: { valid: true, document: redactExtraction(PASSPORT) },
    });
  });

  it('gives an unclassified verdict when none was stored', () => {
    const built = reusedItem('passport.png', stored());
    expect(built.reconciliation).toMatchObject({
      status: 'unclassified',
      effectiveType: 'id_document',
    });
  });
});

describe('buildIndex', () => {
  it('chunks and embeds freshly extracted documents in one call, tokenized', async () => {
    const embedder = letterEmbedder();
    const { chunks, error } = await buildIndex(
      embedder,
      report([item('passport.png', 'h-pass', PASSPORT), item('bill.png', 'h-bill', BILL)]),
    );
    expect(error).toBeNull();
    expect(embedder.calls).toHaveLength(1);
    expect([...chunks.keys()].sort()).toEqual(['h-bill', 'h-pass']);
    const text = (chunks.get('h-pass') ?? []).map((c) => c.text).join(' ');
    expect(text).toContain('[id_number]');
    expect(text).not.toMatch(/1234567|4567/);
    expect(chunks.get('h-pass')?.[0]).toMatchObject({
      documentHash: 'h-pass',
      chunkIndex: 0,
      page: null,
    });
  });

  it('skips reused items and failed extractions without calling the embedder', async () => {
    const embedder = letterEmbedder();
    const { chunks } = await buildIndex(
      embedder,
      report([item('passport.png', 'h-pass', PASSPORT, true), item('bad.png', 'h-bad', null)]),
    );
    expect(chunks.size).toBe(0);
    expect(embedder.calls).toHaveLength(0);
  });

  it('reports an embedder failure instead of rejecting', async () => {
    const embedder: EmbeddingProvider = {
      name: 'down',
      embed: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    const { chunks, error } = await buildIndex(
      embedder,
      report([item('bill.png', 'h-bill', BILL)]),
    );
    expect(chunks.size).toBe(0);
    expect(error).toBe('connection refused');
  });
});

describe('searchStore', () => {
  async function indexedStore() {
    const store = new MemoryStorage();
    const embedder = letterEmbedder();
    const built = await buildIndex(
      embedder,
      report([item('passport.png', 'h-pass', PASSPORT), item('bill.png', 'h-bill', BILL)]),
    );
    for (const [hash, doc] of [
      ['h-pass', stored()],
      ['h-bill', stored({ contentHash: 'h-bill', type: 'bill', extraction: BILL })],
    ] as const) {
      await store.putDocument(doc);
      await store.putChunks(hash, built.chunks.get(hash) ?? []);
    }
    return { store, embedder };
  }

  it('ranks the chunks of the named documents and cites them by display name', async () => {
    const { store, embedder } = await indexedStore();
    const citations = await searchStore(store, embedder, 'passport', 1, {
      documents: new Map([
        ['h-pass', 'passport.png'],
        ['h-bill', 'bill.png'],
      ]),
      indexKey: INDEX,
    });
    expect(citations).toHaveLength(1);
    expect(citations[0]?.source.documentId).toBe('passport.png');
  });

  it('ignores documents outside the scanned folder', async () => {
    const { store, embedder } = await indexedStore();
    const citations = await searchStore(store, embedder, 'passport', 5, {
      documents: new Map([['h-bill', 'bill.png']]),
      indexKey: INDEX,
    });
    expect(citations.map((c) => c.source.documentId)).toEqual(['bill.png']);
  });

  it('ignores chunks indexed under another key', async () => {
    const { store, embedder } = await indexedStore();
    await store.putDocument(stored({ indexKey: 'old-embed|chunk-v1|tokenize-v1' }));
    const citations = await searchStore(store, embedder, 'passport', 5, {
      documents: new Map([['h-pass', 'passport.png']]),
      indexKey: INDEX,
    });
    expect(citations).toEqual([]);
  });

  it('returns nothing without embedding the query when there is nothing to search', async () => {
    const embedder = letterEmbedder();
    const citations = await searchStore(new MemoryStorage(), embedder, 'passport', 5, {
      documents: new Map(),
      indexKey: INDEX,
    });
    expect(citations).toEqual([]);
    expect(embedder.calls).toHaveLength(0);
  });
});
