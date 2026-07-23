/**
 * On-device document-type classifier (ADR-0009).
 *
 * A k-nearest-neighbor vote over labeled example embeddings, using the same
 * brute-force cosine as retrieval (ADR-0005). Seeded with canonical examples
 * per type so it works on day one, then grown with the user's own corrections
 * (the ADR-0008 human-acts loop) via `add`, so it personalizes to their
 * recurring documents. Everything stays in memory here; persistence of the
 * label set is a storage concern (ADR-0005/0007).
 *
 * Confidence is the winning type's share of the similarity-weighted vote among
 * the k nearest neighbors: high when the neighborhood agrees, low when it is
 * split, so callers can route low-confidence documents to human review or a
 * full-VLM re-classification (ADR-0009).
 */

import type { DocumentType } from './extraction-schema.js';
import { cosineSimilarity } from './vector.js';

/** A labeled training example: an embedding and its known document type. */
export interface LabeledExample {
  type: DocumentType;
  embedding: number[];
}

/** A classification result. */
export interface Classification {
  type: DocumentType;
  /** Winning type's share of the similarity-weighted vote, in [0, 1]. */
  confidence: number;
  /** Similarity-weighted vote mass per type among the neighbors considered. */
  votes: Partial<Record<DocumentType, number>>;
}

export class TypeClassifier {
  readonly #examples: LabeledExample[];

  constructor(examples: LabeledExample[] = []) {
    this.#examples = [...examples];
  }

  /** Add labeled examples (e.g. user corrections). */
  add(examples: LabeledExample[]): void {
    this.#examples.push(...examples);
  }

  /** Number of labeled examples. */
  get size(): number {
    return this.#examples.length;
  }

  /**
   * Classify an embedding by a similarity-weighted k-NN vote.
   *
   * Failure modes: returns null when there are no examples. Propagates
   * `RangeError` from the cosine scan if `embedding` has a different dimension
   * than the examples, or if any vector has zero magnitude.
   */
  classify(embedding: number[], k = 5): Classification | null {
    if (this.#examples.length === 0) return null;

    const neighbors = this.#examples
      .map((example) => ({
        type: example.type,
        score: cosineSimilarity(embedding, example.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(k, this.#examples.length));

    const votes = new Map<DocumentType, number>();
    let total = 0;
    for (const neighbor of neighbors) {
      const weight = Math.max(0, neighbor.score);
      votes.set(neighbor.type, (votes.get(neighbor.type) ?? 0) + weight);
      total += weight;
    }

    let bestType: DocumentType = neighbors[0]?.type ?? 'unknown';
    let bestWeight = -1;
    for (const [type, weight] of votes) {
      if (weight > bestWeight) {
        bestType = type;
        bestWeight = weight;
      }
    }

    return {
      type: bestType,
      confidence: total > 0 ? bestWeight / total : 0,
      votes: Object.fromEntries(votes) as Partial<Record<DocumentType, number>>,
    };
  }
}
