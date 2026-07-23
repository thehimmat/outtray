import { describe, expect, it } from 'vitest';
import { type ClassifyRow, tallyClassification } from './classify-eval.js';

// Mirrors the observed live result: the VLM misfiles both bills as statement;
// the classifier corrects them.
const rows: ClassifyRow[] = [
  { id: 'bill-001', label: 'bill', vlm: 'statement', classifier: 'bill', confidence: 0.44 },
  { id: 'bill-002', label: 'bill', vlm: 'statement', classifier: 'bill', confidence: 0.44 },
  { id: 'receipt-001', label: 'receipt', vlm: 'receipt', classifier: 'receipt', confidence: 0.47 },
  { id: 'policy-001', label: 'policy', vlm: 'policy', classifier: 'policy', confidence: 0.48 },
];

describe('tallyClassification', () => {
  it('counts overall accuracy for both labellers', () => {
    const report = tallyClassification(rows);
    expect(report.vlm).toEqual({ k: 2, n: 4 }); // bills wrong
    expect(report.classifier).toEqual({ k: 4, n: 4 }); // all correct
  });

  it('shows the classifier fixing bills per type', () => {
    const report = tallyClassification(rows);
    const bill = report.perType.find((t) => t.type === 'bill');
    expect(bill?.vlm).toEqual({ k: 0, n: 2 });
    expect(bill?.classifier).toEqual({ k: 2, n: 2 });
  });

  it('leaves already-correct types unchanged', () => {
    const report = tallyClassification(rows);
    const receipt = report.perType.find((t) => t.type === 'receipt');
    expect(receipt?.vlm).toEqual({ k: 1, n: 1 });
    expect(receipt?.classifier).toEqual({ k: 1, n: 1 });
  });
});
