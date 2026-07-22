import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  calls = 0;
  constructor(private readonly json: unknown) {}
  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;
    return { json: this.json, jsonChannel: 'content', content: '', thinking: '', doneReason: 'stop', usage };
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
});
