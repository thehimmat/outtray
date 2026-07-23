import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TypeClassifier } from './classifier.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { GenerateRequest, GenerateResult, ModelProvider } from './model-provider.js';
import { scanDirectory } from './scan.js';

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };

const BILL = {
  type: 'bill',
  summary: 'x',
  action_items: [],
  payee: 'p',
  amount_due: '$1',
  due_date: null,
  late_fee: null,
};

const STATEMENT = {
  type: 'statement',
  summary: 'monthly statement',
  action_items: [],
  institution: 'i',
  account_number: 'a',
  period_start: null,
  period_end: null,
  balance: null,
};

/** Embeds every text to the same fixed vector; axes are bill=[1,0,0], statement=[0,1,0]. */
class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake-embed';
  constructor(private readonly vector: number[]) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [...this.vector]);
  }
}

class FailingEmbedder implements EmbeddingProvider {
  readonly name = 'failing-embed';
  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error('embedder unreachable');
  }
}

/** Two labeled axes, so a doc vector picks its winner by direction. */
function axisClassifier(): TypeClassifier {
  return new TypeClassifier([
    { type: 'bill', embedding: [1, 0, 0] },
    { type: 'statement', embedding: [0, 1, 0] },
  ]);
}

/** A provider that returns each canned response in turn, then repeats the last. */
class SequenceProvider implements ModelProvider {
  readonly name = 'sequence';
  calls = 0;
  requests: GenerateRequest[] = [];
  constructor(private readonly responses: Array<unknown | Error>) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const next = this.responses[Math.min(this.calls, this.responses.length - 1)];
    this.calls += 1;
    this.requests.push(req);
    if (next instanceof Error) throw next;
    return {
      json: next,
      jsonChannel: 'content',
      content: '',
      thinking: '',
      doneReason: 'stop',
      usage,
    };
  }
}

class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  calls = 0;
  requests: GenerateRequest[] = [];
  constructor(private readonly json: unknown) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;
    this.requests.push(req);
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

describe('scanDirectory', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'outtray-scan-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts image files and skips the rest, in stable order', async () => {
    await writeFile(join(dir, 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, 'a.jpg'), Buffer.from([0xff, 0xd8]));
    await writeFile(join(dir, 'notes.txt'), 'ignore me');
    const provider = new FakeProvider(BILL);

    const report = await scanDirectory(provider, dir);

    expect(report.scanned).toEqual(['a.jpg', 'b.png']);
    expect(report.skipped).toEqual(['notes.txt']);
    expect(report.items).toHaveLength(2);
    expect(report.items[0]?.result.valid).toBe(true);
    expect(provider.calls).toBe(2);
  });

  it('carries per-file validity through (invalid extraction is not an error)', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    const provider = new FakeProvider({ type: 'bill' }); // missing required fields

    const report = await scanDirectory(provider, dir);

    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.result.valid).toBe(false);
  });

  it('returns empty scanned/items for a directory with no images', async () => {
    await writeFile(join(dir, 'readme.md'), '# hi');
    const report = await scanDirectory(new FakeProvider(BILL), dir);
    expect(report.scanned).toEqual([]);
    expect(report.skipped).toEqual(['readme.md']);
    expect(report.items).toEqual([]);
  });

  it('marks items unclassified when no classify stage is configured', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    const report = await scanDirectory(new FakeProvider(BILL), dir);
    const item = report.items[0];
    expect(item?.reconciliation.status).toBe('unclassified');
    expect(item?.reconciliation.effectiveType).toBe('bill');
    expect(item?.reconciliation.review).toBe(false);
    expect(report.classifierError).toBeNull();
  });

  it('confirms the VLM label when the classifier agrees', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    const report = await scanDirectory(new FakeProvider(BILL), dir, {
      classify: { embedder: new FakeEmbedder([1, 0, 0]), classifier: axisClassifier() },
    });
    const r = report.items[0]?.reconciliation;
    expect(r?.status).toBe('confirmed');
    expect(r?.effectiveType).toBe('bill');
    expect(r?.review).toBe(false);
    expect(r?.classification?.type).toBe('bill');
    expect(report.classifierError).toBeNull();
  });

  it('corrects a confident disagreement via one typed re-extraction', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    const provider = new SequenceProvider([STATEMENT, BILL]);
    const report = await scanDirectory(provider, dir, {
      classify: { embedder: new FakeEmbedder([1, 0, 0]), classifier: axisClassifier() },
    });
    const item = report.items[0];
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.prompt).toContain('bill');
    expect(item?.result.document?.type).toBe('bill');
    const r = item?.reconciliation;
    expect(r?.status).toBe('corrected');
    expect(r?.effectiveType).toBe('bill');
    expect(r?.vlmType).toBe('statement');
    expect(r?.review).toBe(false);
    expect(r?.classification?.type).toBe('bill');
  });

  it('keeps a dispute for review when the re-extraction does not come back as the target type', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    const provider = new SequenceProvider([STATEMENT, STATEMENT]);
    const report = await scanDirectory(provider, dir, {
      classify: { embedder: new FakeEmbedder([1, 0, 0]), classifier: axisClassifier() },
    });
    const item = report.items[0];
    expect(provider.calls).toBe(2);
    expect(item?.result.document?.type).toBe('statement');
    const r = item?.reconciliation;
    expect(r?.status).toBe('disputed');
    expect(r?.effectiveType).toBe('statement');
    expect(r?.vlmType).toBe('statement');
    expect(r?.review).toBe(true);
    expect(r?.classification?.type).toBe('bill');
  });

  it('keeps a dispute for review when the re-extraction call itself fails', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    const provider = new SequenceProvider([STATEMENT, new Error('runtime gone')]);
    const report = await scanDirectory(provider, dir, {
      classify: { embedder: new FakeEmbedder([1, 0, 0]), classifier: axisClassifier() },
    });
    const r = report.items[0]?.reconciliation;
    expect(r?.status).toBe('disputed');
    expect(r?.review).toBe(true);
  });

  it('routes a low-confidence disagreement to unknown and review', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    // cos(bill)=0.751, cos(statement)=0.661: bill wins with share 0.53, under 0.6.
    const report = await scanDirectory(new FakeProvider(STATEMENT), dir, {
      classify: { embedder: new FakeEmbedder([0.75, 0.66, 0]), classifier: axisClassifier() },
    });
    const r = report.items[0]?.reconciliation;
    expect(r?.status).toBe('low_confidence');
    expect(r?.effectiveType).toBe('unknown');
    expect(r?.review).toBe(true);
  });

  it('degrades to single-stage labels when the embedder fails, without rejecting', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    const report = await scanDirectory(new FakeProvider(BILL), dir, {
      classify: { embedder: new FailingEmbedder(), classifier: axisClassifier() },
    });
    expect(report.classifierError).toContain('embedder unreachable');
    const r = report.items[0]?.reconciliation;
    expect(r?.status).toBe('unclassified');
    expect(r?.effectiveType).toBe('bill');
  });

  it('routes invalid extractions to unknown and review, and does not classify them', async () => {
    await writeFile(join(dir, 'doc.png'), Buffer.from([0x89]));
    const provider = new FakeProvider({ type: 'bill' }); // missing required fields
    const report = await scanDirectory(provider, dir, {
      classify: { embedder: new FailingEmbedder(), classifier: axisClassifier() },
    });
    const r = report.items[0]?.reconciliation;
    expect(r?.status).toBe('unclassified');
    expect(r?.effectiveType).toBe('unknown');
    expect(r?.review).toBe(true);
    // The only document is invalid, so the failing embedder is never asked to embed.
    expect(report.classifierError).toBeNull();
  });
});
