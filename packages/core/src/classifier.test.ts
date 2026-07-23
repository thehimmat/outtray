import { describe, expect, it } from 'vitest';
import { TypeClassifier } from './classifier.js';

// Simple 3-d embeddings with a bias dim so nothing is zero-magnitude.
const bill = (x = 1) => [x, 0, 1];
const receipt = (x = 1) => [0, x, 1];

describe('TypeClassifier', () => {
  it('returns null when it has no examples', () => {
    expect(new TypeClassifier([]).classify([1, 0, 1])).toBeNull();
  });

  it('classifies by nearest labeled neighbors', () => {
    const clf = new TypeClassifier([
      { type: 'bill', embedding: bill() },
      { type: 'bill', embedding: bill(0.9) },
      { type: 'receipt', embedding: receipt() },
      { type: 'receipt', embedding: receipt(0.8) },
    ]);
    const result = clf.classify(bill(0.95), 3);
    expect(result?.type).toBe('bill');
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it('reports lower confidence when the neighborhood disagrees', () => {
    const clf = new TypeClassifier([
      { type: 'bill', embedding: [1, 0, 1] },
      { type: 'receipt', embedding: [0, 1, 1] },
    ]);
    // A query equidistant from both should not be confidently either.
    const result = clf.classify([1, 1, 1], 2);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBeLessThan(0.75);
  });

  it('personalizes: added examples shift the decision', () => {
    const clf = new TypeClassifier([{ type: 'statement', embedding: bill() }]);
    expect(clf.classify(bill(), 1)?.type).toBe('statement');
    // The user corrects: this layout is actually a bill. Add several corrections.
    clf.add([
      { type: 'bill', embedding: bill() },
      { type: 'bill', embedding: bill(0.98) },
      { type: 'bill', embedding: bill(0.99) },
    ]);
    expect(clf.classify(bill(), 3)?.type).toBe('bill');
    expect(clf.size).toBe(4);
  });

  it('handles k larger than the example count', () => {
    const clf = new TypeClassifier([{ type: 'letter', embedding: [1, 0, 1] }]);
    expect(clf.classify([1, 0, 1], 10)?.type).toBe('letter');
  });
});
