import { describe, expect, it } from 'vitest';
import { buildClassifier, classifyText, SEED_EXAMPLES } from './classifier-seeds.js';
import type { EmbeddingProvider } from './embedding-provider.js';

// A bag-of-words embedder over the union of all seed words, so texts sharing
// vocabulary with a seed land near it. Deterministic; a bias dim avoids zero
// vectors. This validates wiring, not real-world accuracy (that is the live
// classification scoreboard).
const VOCAB = [...new Set(SEED_EXAMPLES.flatMap((s) => s.text.toLowerCase().split(/\s+/)))];
class BagOfWordsEmbedder implements EmbeddingProvider {
  readonly name = 'bow';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const words = new Set(t.toLowerCase().split(/\s+/));
      return [...VOCAB.map((w) => (words.has(w) ? 1 : 0)), 1];
    });
  }
}

describe('buildClassifier + classifyText', () => {
  it('seeds one labeled example per seed', async () => {
    const clf = await buildClassifier(new BagOfWordsEmbedder());
    expect(clf.size).toBe(SEED_EXAMPLES.length);
  });

  it('classifies representative texts into their type', async () => {
    const embedder = new BagOfWordsEmbedder();
    const clf = await buildClassifier(embedder);

    const cases: Array<[string, string]> = [
      ['your utility bill amount due late fee pay by due date', 'bill'],
      ['sales receipt merchant total items purchased cash change', 'receipt'],
      ['driver license identification card holder name expires issued state', 'id_document'],
      [
        'insurance policy declarations coverage premium policy number expiration deductible',
        'policy',
      ],
    ];
    for (const [text, expected] of cases) {
      const result = await classifyText(clf, embedder, text, 3);
      expect(result?.type, `"${text.slice(0, 20)}..." should classify as ${expected}`).toBe(
        expected,
      );
    }
  });

  it('returns a confidence in [0, 1]', async () => {
    const embedder = new BagOfWordsEmbedder();
    const clf = await buildClassifier(embedder);
    const result = await classifyText(clf, embedder, 'sales receipt total items purchased', 3);
    expect(result?.confidence).toBeGreaterThan(0);
    expect(result?.confidence).toBeLessThanOrEqual(1);
  });
});
