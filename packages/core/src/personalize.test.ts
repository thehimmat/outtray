import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { DocumentExtraction } from './extraction-schema.js';
import { derivedText } from './extraction-text.js';
import { redactExtraction } from './identifiers.js';
import { correctDocument, personalClassifier, reuseOrPin } from './personalize.js';
import { MemoryStorage } from './storage-memory.js';
import type { StoredDocument } from './storage-provider.js';

const EXTRACTOR = 'qwen3-vl:2b|extract-v1|extract-typed-v1';
const INDEX = 'nomic-embed-text|chunk-v1|tokenize-v1';
const KEYS = { extractorKey: EXTRACTOR, indexKey: INDEX, identifierStorage: false };

const BILL: DocumentExtraction = {
  type: 'bill',
  summary: 'Monthly account summary from First Bank.',
  action_items: [],
  payee: 'First Bank',
  amount_due: '$0.00',
  due_date: null,
  late_fee: null,
};

const STATEMENT: DocumentExtraction = {
  type: 'statement',
  summary: 'Monthly statement.',
  action_items: [],
  institution: 'First Bank',
  account_number: '0042117789',
  period_start: null,
  period_end: null,
  balance: null,
};

function stored(overrides: Partial<StoredDocument> = {}): StoredDocument {
  return {
    contentHash: 'h1',
    path: '/pile/stmt.png',
    type: 'bill',
    extraction: redactExtraction(BILL),
    reconciliation: {
      effectiveType: 'bill',
      status: 'confirmed',
      review: false,
      vlmType: 'bill',
      classification: { type: 'bill', confidence: 0.8, votes: { bill: 2 } },
    },
    scannedAt: 1,
    extractorKey: EXTRACTOR,
    indexKey: INDEX,
    userType: null,
    ...overrides,
  };
}

/** Embeds to [length, 1] so every vector is distinct and nonzero; records calls. */
function countingEmbedder(model = 'm1') {
  const calls: string[][] = [];
  const embedder: EmbeddingProvider & { calls: string[][]; model: string } = {
    name: 'counting',
    model,
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => [t.length, 1]);
    },
  };
  return embedder;
}

describe('correctDocument', () => {
  it('pins the type, trusts it, and records a tokenized correction label', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    const outcome = await correctDocument(store, stored(), 'statement');
    expect(outcome).toEqual({ reextract: true, learned: true });

    expect(await store.getDocument('h1')).toMatchObject({
      type: 'statement',
      userType: 'statement',
      reconciliation: {
        effectiveType: 'statement',
        status: 'user',
        review: false,
        vlmType: 'bill',
      },
    });
    const [label] = await store.listLabels();
    expect(label).toMatchObject({
      type: 'statement',
      provenance: 'correction',
      documentHash: 'h1',
      embedModel: null,
      embedding: [],
      text: derivedText(redactExtraction(BILL)),
    });
  });

  it('never puts an identifier, or its last four, into a label', async () => {
    const store = new MemoryStorage();
    const statement = stored({ type: 'statement', extraction: redactExtraction(STATEMENT) });
    await store.putDocument(statement);
    await correctDocument(store, statement, 'bill');
    const [label] = await store.listLabels();
    expect(label?.text).toContain('[account_number]');
    expect(label?.text).not.toMatch(/0042117789|7789/);
  });

  it('replaces an earlier correction of the same document', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    await correctDocument(store, stored(), 'statement');
    await correctDocument(store, stored(), 'receipt');
    expect((await store.listLabels()).map((l) => l.type)).toEqual(['receipt']);
  });

  it('needs no re-extraction when the extraction is already of the pinned type', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    expect(await correctDocument(store, stored(), 'bill')).toEqual({
      reextract: false,
      learned: true,
    });
  });

  it('pins a document whose extraction failed, without a label to learn from', async () => {
    const store = new MemoryStorage();
    const failed = stored({ extraction: null, type: null, reconciliation: null });
    await store.putDocument(failed);
    expect(await correctDocument(store, failed, 'statement')).toEqual({
      reextract: true,
      learned: false,
    });
    expect(await store.listLabels()).toEqual([]);
    expect(await store.getDocument('h1')).toMatchObject({
      userType: 'statement',
      reconciliation: { status: 'user', review: true },
    });
  });
});

describe('reuseOrPin', () => {
  it('reuses a current document', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    const answer = await reuseOrPin(store, 'stmt.png', 'h1', KEYS);
    expect(answer && 'reused' in answer && answer.reused).toBe(true);
  });

  it('asks for extraction under the pinned type when the stored extraction is another type', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored({ userType: 'statement' }));
    expect(await reuseOrPin(store, 'stmt.png', 'h1', KEYS)).toEqual({ extractAs: 'statement' });
  });

  it('reuses a pinned document once its extraction matches the pin', async () => {
    const store = new MemoryStorage();
    await store.putDocument(
      stored({ userType: 'statement', type: 'statement', extraction: redactExtraction(STATEMENT) }),
    );
    const answer = await reuseOrPin(store, 'stmt.png', 'h1', KEYS);
    expect(answer && 'reused' in answer).toBe(true);
  });

  it('extracts under the pin again when keys changed, and as usual for unknown files', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored({ userType: 'bill', indexKey: null }));
    expect(await reuseOrPin(store, 'stmt.png', 'h1', KEYS)).toEqual({ extractAs: 'bill' });
    expect(await reuseOrPin(store, 'new.png', 'h-new', KEYS)).toBeNull();
  });
});

describe('personalClassifier', () => {
  it('is the seeds alone when there are no corrections', async () => {
    const store = new MemoryStorage();
    const embedder = countingEmbedder();
    const classifier = await personalClassifier(store, embedder, 'm1');
    expect(embedder.calls).toHaveLength(1);
    expect(classifier.size).toBe(embedder.calls[0]?.length);
  });

  it('adds corrections, embedding the ones not yet embedded under this model, once', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    await correctDocument(store, stored(), 'statement');
    const embedder = countingEmbedder();
    const seedsOnly = (await personalClassifier(new MemoryStorage(), countingEmbedder(), 'm1'))
      .size;

    const classifier = await personalClassifier(store, embedder, 'm1');
    expect(classifier.size).toBe(seedsOnly + 1);
    expect(embedder.calls).toHaveLength(2);
    expect(await store.listLabels()).toMatchObject([{ embedModel: 'm1' }]);

    const again = countingEmbedder();
    await personalClassifier(store, again, 'm1');
    expect(again.calls).toHaveLength(1);
  });

  it('re-embeds corrections made under another embedding model', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    await correctDocument(store, stored(), 'statement');
    await personalClassifier(store, countingEmbedder(), 'm1');
    const embedder = countingEmbedder('m2');
    await personalClassifier(store, embedder, 'm2');
    expect(embedder.calls).toHaveLength(2);
    expect(await store.listLabels()).toMatchObject([{ embedModel: 'm2' }]);
  });

  it('lets a correction outvote the seeds for a document like it', async () => {
    const store = new MemoryStorage();
    await store.putDocument(stored());
    await correctDocument(store, stored(), 'statement');
    const embedder = countingEmbedder();
    const classifier = await personalClassifier(store, embedder, 'm1');
    const [query] = await embedder.embed([derivedText(BILL)]);
    expect(classifier.classify(query ?? [], 1)?.type).toBe('statement');
  });
});
