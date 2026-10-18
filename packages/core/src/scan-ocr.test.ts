import { describe, expect, it } from 'vitest';
import { TypeClassifier } from './classifier.js';
import type { DocumentSource } from './document-source.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { TYPED_PROMPT_VERSION, typedExtractionPrompt } from './extract.js';
import { extractorKeyFor } from './incremental.js';
import type { GenerateRequest, GenerateResult, ModelProvider } from './model-provider.js';
import type { OcrResult } from './ocr-contract.js';
import { type OcrRecognizer, ROUTING_VERSION, scanSource } from './scan.js';

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };

const BILL = {
  type: 'bill',
  summary: 'electric bill',
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

/** Every call and model stage in order, so tests can check what ran when. */
type Log = string[];

function memorySource(names: string[]): DocumentSource {
  return {
    list: async () => [...names],
    read: async (name) => new TextEncoder().encode(name),
    locate: (name) => `/pile/${name}`,
  };
}

/** A page of body-sized lines spelling `text`: readable per #163 when long enough. */
function page(text: string, lineHeight = 0.015): OcrResult {
  const chunks = text.match(/.{1,40}/g) ?? [];
  return {
    contract: 'ocr-v1',
    engine: 'vision-recognize-text',
    engineRevision: 3,
    elapsedMs: 5,
    pages: [
      {
        width: 1000,
        height: 1400,
        lines: chunks.map((t, i) => ({
          text: t,
          confidence: 1,
          box: { x: 0.1, y: Math.min(0.9, 0.05 + i * 0.03), width: 0.5, height: lineHeight },
        })),
      },
    ],
  };
}

const BILL_TEXT = `ELECTRIC BILL ${'amount due by the due date, pay now to avoid a late fee. '.repeat(3)}`;
const STATEMENT_TEXT = `MONTHLY STATEMENT ${'account balance for the period, opening and closing. '.repeat(3)}`;
const VAGUE_TEXT = `VAGUE ${'this page could be anything at all, really, who knows. '.repeat(3)}`;

class FakeRecognizer implements OcrRecognizer {
  readonly key = 'ocr-v1:fake';
  constructor(
    private readonly pages: Record<string, OcrResult | Error>,
    private readonly log: Log,
  ) {}
  async recognize(file: string): Promise<OcrResult> {
    this.log.push(`ocr ${file}`);
    const result = this.pages[file];
    if (result === undefined) throw new Error(`no page for ${file}`);
    if (result instanceof Error) throw result;
    return result;
  }
}

/** Embeds by keyword: bill=[1,0,0], statement=[0,1,0], anything else halfway. */
class KeywordEmbedder implements EmbeddingProvider {
  readonly name = 'keyword-embed';
  constructor(private readonly log: Log) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.log.push(`embed ${texts.length}`);
    return texts.map((t) => {
      const s = t.toLowerCase();
      if (s.includes('bill')) return [1, 0, 0];
      if (s.includes('statement')) return [0, 1, 0];
      return [1, 1, 0];
    });
  }
}

function axisClassifier(): TypeClassifier {
  return new TypeClassifier([
    { type: 'bill', embedding: [1, 0, 0] },
    { type: 'statement', embedding: [0, 1, 0] },
  ]);
}

/** Answers per file (the image is the file name's bytes), typed or generic by prompt. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  requests: GenerateRequest[] = [];
  constructor(
    private readonly answer: (file: string, typed: boolean) => unknown,
    private readonly log: Log,
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const file = Buffer.from(req.images?.[0] ?? '', 'base64').toString();
    const typed = !req.prompt.startsWith('You are a document triage assistant. Classify');
    this.log.push(`vlm ${typed ? 'typed' : 'generic'} ${file}`);
    return {
      json: this.answer(file, typed),
      jsonChannel: 'content',
      content: '',
      thinking: '',
      doneReason: 'stop',
      usage,
    };
  }
}

function setup(
  pages: Record<string, OcrResult | Error>,
  answer: (file: string, typed: boolean) => unknown,
) {
  const log: Log = [];
  return {
    log,
    provider: new ScriptedProvider(answer, log),
    ocr: new FakeRecognizer(pages, log),
    embedder: new KeywordEmbedder(log),
  };
}

describe('scanSource with an OCR recognizer (classify first, ADR-0009 amendment 3)', () => {
  it('routes a confident vote on the OCR text straight to the typed prompt: one vision call', async () => {
    // The generic prompt would mislabel this bill a statement; it is never asked.
    const { provider, ocr, embedder } = setup({ 'a.png': page(BILL_TEXT) }, (_f, typed) =>
      typed ? BILL : STATEMENT,
    );

    const report = await scanSource(provider, memorySource(['a.png']), {
      ocr,
      classify: { embedder, classifier: axisClassifier() },
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.prompt).toBe(typedExtractionPrompt('bill'));
    const item = report.items[0];
    expect(item?.result.document?.type).toBe('bill');
    expect(item?.reconciliation).toMatchObject({
      effectiveType: 'bill',
      status: 'routed',
      review: false,
      vlmType: null,
    });
    expect(item?.reconciliation.classification?.type).toBe('bill');
    expect(item?.ocr).toEqual({ readable: true, reasons: [], error: null });
  });

  it('reads and votes on every page before any vision call, in one embedder call', async () => {
    const { log, provider, ocr, embedder } = setup(
      { 'a.png': page(BILL_TEXT), 'b.png': page(STATEMENT_TEXT) },
      (f) => (f === 'a.png' ? BILL : STATEMENT),
    );

    await scanSource(provider, memorySource(['b.png', 'a.png']), {
      ocr,
      classify: { embedder, classifier: axisClassifier() },
    });

    expect(log.slice(0, 4)).toEqual(['ocr a.png', 'ocr b.png', 'embed 2', 'vlm typed a.png']);
    expect(log.filter((l) => l.startsWith('embed'))).toEqual(['embed 2']);
  });

  it('falls back to the generic prompt when the typed call does not come back as that type', async () => {
    const { provider, ocr, embedder } = setup({ 'a.png': page(BILL_TEXT) }, (_f, typed) =>
      typed ? { not: 'valid' } : STATEMENT,
    );

    const report = await scanSource(provider, memorySource(['a.png']), {
      ocr,
      classify: { embedder, classifier: axisClassifier() },
    });

    // Typed, then generic, and no second typed attempt: it has had its one.
    expect(provider.requests).toHaveLength(2);
    expect(report.items[0]?.result.document?.type).toBe('statement');
    expect(report.items[0]?.reconciliation).toMatchObject({
      status: 'disputed',
      review: true,
      vlmType: 'statement',
    });
  });

  it('confirms a fallback whose generic label agrees with the vote', async () => {
    const { provider, ocr, embedder } = setup({ 'a.png': page(BILL_TEXT) }, (_f, typed) =>
      typed ? { not: 'valid' } : BILL,
    );

    const report = await scanSource(provider, memorySource(['a.png']), {
      ocr,
      classify: { embedder, classifier: axisClassifier() },
    });

    expect(report.items[0]?.reconciliation.status).toBe('confirmed');
  });

  it('extracts generically under a low-confidence vote and classifies the extraction text instead', async () => {
    // Measured on the Air (#171): a weak, wrong OCR vote (letter-002 voting bill
    // at 0.35) used to stand in for the extraction-text vote and sent a
    // correctly read letter to review. A vote too weak to route now settles
    // nothing; the item is classified exactly as it would be without OCR.
    const { log, provider, ocr, embedder } = setup(
      { 'a.png': page(VAGUE_TEXT), 'b.png': page(VAGUE_TEXT) },
      (f) => (f === 'a.png' ? BILL : STATEMENT),
    );

    const report = await scanSource(provider, memorySource(['a.png', 'b.png']), {
      ocr,
      // A tie between the axes: confidence 0.5, under the 0.6 threshold.
      classify: { embedder, classifier: axisClassifier(), k: 2 },
    });

    expect(provider.requests.every((r) => !r.prompt.includes('This document'))).toBe(true);
    expect(log.filter((l) => l.startsWith('embed'))).toEqual(['embed 2', 'embed 2']);
    for (const item of report.items) {
      expect(item.reconciliation.status).toBe('confirmed');
      expect(item.reconciliation.review).toBe(false);
      expect(item.reconciliation.classification?.type).toBe(item.result.document?.type);
      expect(item.reconciliation.classification?.confidence).toBe(1);
    }
  });

  it('re-extracts once when the extraction-text vote confidently disputes a weak-vote item', async () => {
    // The OCR vote is a tie; the generic label is statement; the extraction
    // text says bill. That is the ordinary disputed path, with its one retry.
    const { provider, ocr, embedder } = setup({ 'a.png': page(VAGUE_TEXT) }, (_f, typed) =>
      typed ? BILL : { ...STATEMENT, summary: 'electric bill' },
    );

    const report = await scanSource(provider, memorySource(['a.png']), {
      ocr,
      classify: { embedder, classifier: axisClassifier(), k: 2 },
    });

    expect(provider.requests.map((r) => r.prompt === typedExtractionPrompt('bill'))).toEqual([
      false,
      true,
    ]);
    expect(report.items[0]?.reconciliation).toMatchObject({
      effectiveType: 'bill',
      status: 'corrected',
    });
  });

  it('sends a page the OCR could not read down the extract-then-classify path', async () => {
    // Headings only: few characters in tall lines (#163).
    const { log, provider, ocr, embedder } = setup(
      { 'a.png': page('ELECTRIC BILL', 0.04) },
      () => STATEMENT,
    );

    const report = await scanSource(provider, memorySource(['a.png']), {
      ocr,
      classify: { embedder, classifier: axisClassifier() },
    });

    // No vote on the OCR text; the extraction is classified after it, as before.
    expect(log).toEqual(['ocr a.png', 'vlm generic a.png', 'embed 1']);
    const item = report.items[0];
    expect(item?.ocr?.readable).toBe(false);
    expect(item?.ocr?.reasons).toEqual(['too-little-text', 'only-large-text']);
    expect(item?.reconciliation.status).toBe('confirmed');
  });

  it('keeps going when the OCR fails on one file, extracting it the old way', async () => {
    const { provider, ocr, embedder } = setup(
      { 'a.png': new Error('Vision failed'), 'b.png': page(BILL_TEXT) },
      () => BILL,
    );

    const report = await scanSource(provider, memorySource(['a.png', 'b.png']), {
      ocr,
      classify: { embedder, classifier: axisClassifier() },
    });

    const [a, b] = report.items;
    expect(a?.ocr).toEqual({ readable: false, reasons: [], error: 'Vision failed' });
    expect(a?.reconciliation.status).toBe('confirmed');
    expect(b?.reconciliation.status).toBe('routed');
  });

  it('degrades to the old path when the vote cannot be taken', async () => {
    const log: Log = [];
    const failing: EmbeddingProvider = {
      name: 'failing',
      embed: async () => {
        throw new Error('embedder unreachable');
      },
    };
    const report = await scanSource(
      new ScriptedProvider(() => BILL, log),
      memorySource(['a.png']),
      {
        ocr: new FakeRecognizer({ 'a.png': page(BILL_TEXT) }, log),
        classify: { embedder: failing, classifier: axisClassifier() },
      },
    );

    expect(report.classifierError).toBe('embedder unreachable');
    expect(report.items[0]?.reconciliation.status).toBe('unclassified');
    expect(report.items[0]?.result.document?.type).toBe('bill');
  });

  it('does not read reused or pinned files, and ignores OCR without a classify stage', async () => {
    const { log, provider, ocr, embedder } = setup(
      { 'a.png': page(BILL_TEXT), 'b.png': page(BILL_TEXT) },
      () => BILL,
    );

    await scanSource(provider, memorySource(['a.png', 'b.png']), {
      ocr,
      classify: { embedder, classifier: axisClassifier() },
      reuse: async (file) => (file === 'a.png' ? { extractAs: 'bill' } : null),
    });
    expect(log.filter((l) => l.startsWith('ocr'))).toEqual(['ocr b.png']);

    log.length = 0;
    await scanSource(provider, memorySource(['a.png']), { ocr });
    expect(log).toEqual(['vlm generic a.png']);
  });

  it('reads each file once without an OCR stage, as before', async () => {
    const reads: string[] = [];
    const counted: DocumentSource = {
      ...memorySource(['a.png', 'b.png']),
      read: async (name) => {
        reads.push(name);
        return new TextEncoder().encode(name);
      },
    };
    const { provider } = setup({}, () => BILL);

    await scanSource(provider, counted);

    expect(reads).toEqual(['a.png', 'b.png']);
  });

  it('builds the personal classifier once for both votes', async () => {
    const { provider, ocr, embedder } = setup(
      { 'a.png': page(BILL_TEXT), 'b.png': page('BILL', 0.04) },
      () => BILL,
    );
    let built = 0;

    await scanSource(provider, memorySource(['a.png', 'b.png']), {
      ocr,
      classify: {
        embedder,
        classifier: async () => {
          built += 1;
          return axisClassifier();
        },
      },
    });

    expect(built).toBe(1);
  });
});

describe('extractorKeyFor with OCR', () => {
  it('names the recognizer and the routing version, so toggling OCR re-extracts', () => {
    const plain = extractorKeyFor('qwen3-vl:2b');
    const withOcr = extractorKeyFor('qwen3-vl:2b', 'ocr-v1:vision');
    expect(plain).toContain(TYPED_PROMPT_VERSION);
    expect(withOcr).toBe(`${plain}|ocr-v1:vision|${ROUTING_VERSION}`);
  });
});
