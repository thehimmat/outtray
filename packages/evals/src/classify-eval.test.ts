import { type EmbeddingProvider, type OcrResult, TypeClassifier } from '@outtray/core';
import { describe, expect, it } from 'vitest';
import {
  type ClassifyRow,
  type OcrVoteRow,
  ocrVotes,
  tallyClassification,
  tallyOcrVotes,
} from './classify-eval.js';
import type { ManifestEntry } from './fixtures/load.js';
import type { OcrPage } from './ocr-eval.js';

// Mirrors the observed live result: the VLM misfiles both bills as statement;
// the classifier flags them and the typed re-extraction corrects them.
const rows: ClassifyRow[] = [
  {
    id: 'bill-001',
    label: 'bill',
    vlm: 'statement',
    classifier: 'bill',
    confidence: 0.68,
    reconciled: 'bill',
    status: 'corrected',
  },
  {
    id: 'bill-002',
    label: 'bill',
    vlm: 'statement',
    classifier: 'bill',
    confidence: 0.69,
    reconciled: 'bill',
    status: 'corrected',
  },
  {
    id: 'receipt-001',
    label: 'receipt',
    vlm: 'receipt',
    classifier: 'receipt',
    confidence: 0.7,
    reconciled: 'receipt',
    status: 'confirmed',
  },
  {
    id: 'policy-001',
    label: 'policy',
    vlm: 'policy',
    classifier: 'policy',
    confidence: 0.73,
    reconciled: 'policy',
    status: 'confirmed',
  },
];

describe('tallyClassification', () => {
  it('counts overall accuracy for all three labellers', () => {
    const report = tallyClassification(rows);
    expect(report.vlm).toEqual({ k: 2, n: 4 }); // bills wrong
    expect(report.classifier).toEqual({ k: 4, n: 4 }); // all correct
    expect(report.reconciled).toEqual({ k: 4, n: 4 }); // corrections hold end to end
  });

  it('shows the classifier and reconciliation fixing bills per type', () => {
    const report = tallyClassification(rows);
    const bill = report.perType.find((t) => t.type === 'bill');
    expect(bill?.vlm).toEqual({ k: 0, n: 2 });
    expect(bill?.classifier).toEqual({ k: 2, n: 2 });
    expect(bill?.reconciled).toEqual({ k: 2, n: 2 });
  });

  it('leaves already-correct types unchanged', () => {
    const report = tallyClassification(rows);
    const receipt = report.perType.find((t) => t.type === 'receipt');
    expect(receipt?.vlm).toEqual({ k: 1, n: 1 });
    expect(receipt?.classifier).toEqual({ k: 1, n: 1 });
    expect(receipt?.reconciled).toEqual({ k: 1, n: 1 });
  });

  it('counts a failed correction against the reconciled column only', () => {
    const stuck: ClassifyRow = {
      id: 'bill-003',
      label: 'bill',
      vlm: 'statement',
      classifier: 'bill',
      confidence: 0.68,
      reconciled: 'statement',
      status: 'disputed',
    };
    const report = tallyClassification([...rows, stuck]);
    expect(report.classifier).toEqual({ k: 5, n: 5 });
    expect(report.reconciled).toEqual({ k: 4, n: 5 });
  });
});

/** An OCR result of `n` copies of `text`, at body-text line height. */
function ocrOf(text: string, n = 8, lineHeight = 0.015): OcrResult {
  return {
    contract: 'ocr-v1',
    engine: 'vision-recognize-text',
    engineRevision: 1,
    elapsedMs: 1,
    pages: [
      {
        width: 1000,
        height: 1000,
        lines: Array.from({ length: n }, (_, i) => ({
          text,
          confidence: 1,
          box: { x: 0.1, y: 0.05 + i * 0.03, width: 0.5, height: lineHeight },
        })),
      },
    ],
  };
}

function page(id: string, type: ManifestEntry['type'], level: OcrPage['level'] = 'clean'): OcrPage {
  const source = { id, type } as ManifestEntry;
  return { id, level, source, imagePath: `${id}.png`, imageSha256: '' };
}

/** Embeds by keyword: bill=[1,0], statement=[0,1], anything else halfway. */
class KeywordEmbedder implements EmbeddingProvider {
  readonly name = 'keyword-embed';
  calls: string[][] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => {
      const s = t.toLowerCase();
      if (s.includes('bill')) return [1, 0];
      if (s.includes('statement')) return [0, 1];
      return [1, 1];
    });
  }
}

const axis = () =>
  new TypeClassifier([
    { type: 'bill', embedding: [1, 0] },
    { type: 'statement', embedding: [0, 1] },
  ]);

describe('ocrVotes', () => {
  it('votes on readable OCR text and routes a vote at or above the threshold', async () => {
    const texts: Record<string, OcrResult> = {
      'bill-001': ocrOf('electric bill, amount due by the due date'),
      'policy-001': ocrOf('vague page, could be anything at all really'),
    };
    const embedder = new KeywordEmbedder();
    const rows = await ocrVotes(
      [page('bill-001', 'bill'), page('policy-001', 'policy')],
      async (p) => texts[p.id] as OcrResult,
      embedder,
      axis(),
      { k: 2, threshold: 0.6 },
    );
    expect(rows).toEqual([
      expect.objectContaining({ id: 'bill-001', label: 'bill', vote: 'bill', routed: true }),
      expect.objectContaining({ id: 'policy-001', label: 'policy', vote: 'bill', routed: false }),
    ]);
    expect(rows[0]?.confidence).toBe(1);
    expect(rows[1]?.confidence).toBeCloseTo(0.5);
    expect(embedder.calls).toHaveLength(1); // one batch, as scan embeds
  });

  it('gives an unreadable page no vote and never routes it, as scan does', async () => {
    const embedder = new KeywordEmbedder();
    const rows = await ocrVotes(
      [page('bill-001.harsh', 'bill', 'harsh')],
      async () => ocrOf('bill', 1),
      embedder,
      axis(),
    );
    expect(rows[0]).toMatchObject({
      vote: 'unreadable',
      confidence: null,
      routed: false,
      readable: false,
    });
    expect(embedder.calls).toHaveLength(0);
  });
});

describe('tallyOcrVotes', () => {
  const vote = (over: Partial<OcrVoteRow>): OcrVoteRow => ({
    id: 'x',
    label: 'bill',
    level: 'clean',
    readable: true,
    vote: 'bill',
    confidence: 0.9,
    routed: true,
    ...over,
  });

  it('counts accuracy, routed votes, and routed votes that are wrong', () => {
    const t = tallyOcrVotes([
      vote({ id: 'a' }),
      vote({ id: 'b', vote: 'statement', confidence: 0.7 }),
      vote({ id: 'c', vote: 'statement', confidence: 0.5, routed: false }),
      vote({ id: 'd', vote: 'unreadable', confidence: null, routed: false, readable: false }),
    ]);
    expect(t.accuracy).toEqual({ k: 1, n: 4 });
    expect(t.routed).toBe(2);
    expect(t.routedWrong).toEqual(['b']);
    expect(t.unreadable).toBe(1);
  });
});

describe('tallyClassification with an OCR column', () => {
  it('counts the OCR vote per type next to the other labellers', () => {
    const withOcr = rows.map((r) => ({ ...r, ocr: r.id === 'bill-002' ? 'statement' : r.label }));
    const report = tallyClassification(withOcr);
    expect(report.ocr).toEqual({ k: 3, n: 4 });
    expect(report.perType.find((t) => t.type === 'bill')?.ocr).toEqual({ k: 1, n: 2 });
  });

  it('leaves the OCR column empty when no row has an OCR vote', () => {
    expect(tallyClassification(rows).ocr).toEqual({ k: 0, n: 0 });
  });
});
