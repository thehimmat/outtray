import { describe, expect, it } from 'vitest';
import type { DocumentSource } from './document-source.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { extractorKeyFor } from './incremental.js';
import type { GenerateRequest, GenerateResult, ModelProvider } from './model-provider.js';
import type { OcrResult } from './ocr-contract.js';
import { scanWithStore } from './pipeline.js';
import type { OcrRecognizer } from './scan.js';
import { MemoryStorage } from './storage-memory.js';

const BILL = {
  type: 'bill',
  summary: 'electric bill',
  action_items: [],
  payee: 'p',
  amount_due: '$1',
  due_date: null,
  late_fee: null,
};

const source: DocumentSource = {
  list: async () => ['a.png'],
  read: async (name) => new TextEncoder().encode(name),
  locate: (name) => `/pile/${name}`,
};

class CountingProvider implements ModelProvider {
  readonly name = 'counting';
  calls = 0;
  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;
    return {
      json: BILL,
      jsonChannel: 'content',
      content: '',
      thinking: '',
      doneReason: 'stop',
      usage: { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 },
    };
  }
}

const embedder: EmbeddingProvider = {
  name: 'flat',
  embed: async (texts) => texts.map(() => [1, 0, 0]),
};

const billPage: OcrResult = {
  contract: 'ocr-v1',
  engine: 'vision-recognize-text',
  engineRevision: 3,
  elapsedMs: 1,
  pages: [
    {
      width: 10,
      height: 10,
      lines: Array.from({ length: 6 }, (_, i) => ({
        text: 'electric bill, amount due by the due date',
        confidence: 1,
        box: { x: 0, y: i * 0.05, width: 0.5, height: 0.015 },
      })),
    },
  ],
};

function recognizer(): OcrRecognizer & { calls: number } {
  const r = {
    key: 'ocr-v1:fake',
    calls: 0,
    recognize: async () => {
      r.calls += 1;
      return billPage;
    },
  };
  return r;
}

const base = { embedder, source, identifierStorage: false, extractModel: 'm', embedModel: 'e' };

describe('scanWithStore with OCR (ADR-0009 amendment 3)', () => {
  it('keys stored documents by the recognizer, so toggling OCR re-extracts once', async () => {
    const storage = new MemoryStorage();
    const provider = new CountingProvider();
    const ocr = recognizer();

    const first = await scanWithStore({ ...base, provider, storage, ocr });
    expect(first.report.items[0]?.reconciliation.status).toBe('routed');
    const [stored] = await storage.listDocuments();
    expect(stored?.extractorKey).toBe(extractorKeyFor('m', 'ocr-v1:fake'));

    // Unchanged and still on: reused, so neither OCR nor the VLM runs.
    await scanWithStore({ ...base, provider, storage, ocr });
    expect(provider.calls).toBe(1);
    expect(ocr.calls).toBe(1);

    // Off: the key no longer matches, so it is extracted the old way.
    const off = await scanWithStore({ ...base, provider, storage });
    expect(provider.calls).toBe(2);
    expect(off.report.items[0]?.reused).toBeUndefined();
  });
});
