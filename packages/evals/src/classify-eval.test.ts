import { describe, expect, it } from 'vitest';
import { type ClassifyRow, tallyClassification } from './classify-eval.js';

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
