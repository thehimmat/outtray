/**
 * Brute-force vector similarity over embedding vectors.
 *
 * Per ADR-0005 there is no vector database: a personal document corpus is
 * thousands of chunks, and a linear scan of normalized dot products is well
 * under 50ms at that scale. Embeddings are stored as BLOBs in SQLite and
 * ranked here.
 */

/**
 * Cosine similarity between two vectors.
 *
 * Failure modes: throws `RangeError` if the vectors differ in length, are
 * empty, or either has zero magnitude (cosine is undefined for the zero
 * vector). Never returns NaN.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new RangeError(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  if (a.length === 0) {
    throw new RangeError('cosineSimilarity: empty vectors');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    throw new RangeError('cosineSimilarity: zero-magnitude vector');
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rank candidate vectors by cosine similarity to a query vector, descending.
 * Returns indices into `candidates` with their scores.
 *
 * Failure modes: throws `RangeError` (propagated from `cosineSimilarity`) if
 * any candidate's length differs from the query's, or if the query or any
 * candidate has zero magnitude.
 */
export function rankBySimilarity(
  query: ArrayLike<number>,
  candidates: ReadonlyArray<ArrayLike<number>>,
): Array<{ index: number; score: number }> {
  return candidates
    .map((candidate, index) => ({ index, score: cosineSimilarity(query, candidate) }))
    .sort((left, right) => right.score - left.score);
}
