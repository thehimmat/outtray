import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from './embedding-provider.js';
import { extractionText } from './extraction-text.js';
import { findInDirectory } from './find.js';
import type { GenerateRequest, GenerateResult, ModelProvider } from './model-provider.js';

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };

const BILL = {
  type: 'bill',
  summary: 'Utility bill from Metro Electric.',
  action_items: [{ text: 'Pay $91 by Feb 16', due_date: '2027-02-16' }],
  payee: 'Metro Electric',
  amount_due: '$91.00',
  due_date: '2027-02-16',
  late_fee: '$56.00',
};

/** Returns the same document for every page. */
class StubModel implements ModelProvider {
  readonly name = 'stub';
  constructor(private readonly json: unknown) {}
  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    return {
      json: this.json,
      jsonChannel: 'content',
      content: '',
      thinking: '',
      doneReason: 'stop',
      usage,
    };
  }
}

const VOCAB = ['metro', 'electric', 'butter', 'renewal'] as const;
class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      return [...VOCAB.map((w) => lower.split(w).length - 1), 1];
    });
  }
}

describe('extractionText', () => {
  it('flattens a document into retrieval text with its fields', () => {
    const text = extractionText(BILL as never);
    expect(text).toContain('Utility bill from Metro Electric');
    expect(text).toContain('Pay $91 by Feb 16');
    expect(text.toLowerCase()).toContain('metro electric');
  });
});

describe('findInDirectory', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'outtray-find-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts, indexes, and returns cited passages for a query', async () => {
    await writeFile(join(dir, 'metro.png'), Buffer.from([0x89]));
    const { citations, scanned } = await findInDirectory(
      new StubModel(BILL),
      new FakeEmbedder(),
      dir,
      'metro electric bill',
      3,
      { model: 'qwen3-vl:2b' },
    );
    expect(scanned.scanned).toEqual(['metro.png']);
    expect(citations.length).toBeGreaterThanOrEqual(1);
    expect(citations[0]?.source.documentId).toBe('metro.png');
    expect(citations[0]?.text.toLowerCase()).toContain('metro');
  });

  it('returns no citations when no document could be extracted', async () => {
    await writeFile(join(dir, 'bad.png'), Buffer.from([0x89]));
    const { citations } = await findInDirectory(
      new StubModel(null), // invalid extraction
      new FakeEmbedder(),
      dir,
      'anything',
      3,
      { model: 'qwen3-vl:2b' },
    );
    expect(citations).toEqual([]);
  });
});
