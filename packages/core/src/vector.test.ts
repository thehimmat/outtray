import { describe, expect, it } from 'vitest';
import { cosineSimilarity, rankBySimilarity } from './vector.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical direction', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite direction', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
  });

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(RangeError);
  });

  it('throws on empty vectors', () => {
    expect(() => cosineSimilarity([], [])).toThrow(RangeError);
  });

  it('throws on zero-magnitude vectors instead of returning NaN', () => {
    expect(() => cosineSimilarity([0, 0], [1, 2])).toThrow(RangeError);
    expect(() => cosineSimilarity([1, 2], [0, 0])).toThrow(RangeError);
  });

  it('works with typed arrays', () => {
    expect(cosineSimilarity(Float32Array.from([3, 4]), Float32Array.from([3, 4]))).toBeCloseTo(
      1,
      6,
    );
  });
});

describe('rankBySimilarity', () => {
  it('ranks the most similar candidate first and preserves indices', () => {
    const ranked = rankBySimilarity(
      [1, 0],
      [
        [0, 1],
        [1, 0.1],
        [-1, 0],
      ],
    );
    expect(ranked.map((r) => r.index)).toEqual([1, 0, 2]);
    expect(ranked[0]?.score).toBeGreaterThan(0.9);
  });

  it('returns an empty ranking for no candidates', () => {
    expect(rankBySimilarity([1, 0], [])).toEqual([]);
  });
});
