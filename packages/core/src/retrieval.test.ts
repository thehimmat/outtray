import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from './embedding-provider.js';
import { indexDocuments, search, VectorIndex } from './retrieval.js';

// Deterministic embedder: vocab-word counts plus a constant bias dim so no
// vector is ever zero-magnitude. A query shares direction with chunks that use
// the same words.
const VOCAB = ['butter', 'milk', 'coffee', 'invoice', 'renewal'] as const;
class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake';
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((t) => {
      const lower = t.toLowerCase();
      const counts = VOCAB.map((w) => lower.split(w).length - 1);
      return [...counts, 1];
    });
  }
}

describe('VectorIndex.retrieve', () => {
  it('returns nothing from an empty index', () => {
    expect(new VectorIndex().retrieve([1, 0, 0, 0, 0, 1], 3)).toEqual([]);
  });

  it('ranks by cosine similarity and keeps the source ref', () => {
    const index = new VectorIndex();
    index.add([
      {
        text: 'about butter',
        embedding: [1, 0, 0, 0, 0, 1],
        source: { documentId: 'a', page: undefined, chunkIndex: 0 },
      },
      {
        text: 'about coffee',
        embedding: [0, 0, 1, 0, 0, 1],
        source: { documentId: 'b', page: 2, chunkIndex: 0 },
      },
    ]);
    const hits = index.retrieve([1, 0, 0, 0, 0, 1], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe('about butter');
    expect(hits[0]?.source).toEqual({ documentId: 'a', page: undefined, chunkIndex: 0 });
    expect(hits[0]?.score).toBeGreaterThan(0.9);
  });
});

describe('indexDocuments + search', () => {
  const docs = [
    { id: 'grocery.png', text: 'Butter unsalted and whole milk were purchased today.' },
    { id: 'renewal.png', text: 'Vehicle registration renewal invoice, payment due soon.' },
  ];

  it('retrieves the passage from the document matching the query, with a citation', async () => {
    const embedder = new FakeEmbedder();
    const index = await indexDocuments(embedder, docs);
    const hits = await search(index, embedder, 'where is the cheapest butter', 1);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.source.documentId).toBe('grocery.png');
    expect(hits[0]?.text.toLowerCase()).toContain('butter');
  });

  it('cites the renewal document for a renewal query', async () => {
    const embedder = new FakeEmbedder();
    const index = await indexDocuments(embedder, docs);
    const hits = await search(index, embedder, 'when is my renewal invoice due', 2);
    expect(hits[0]?.source.documentId).toBe('renewal.png');
  });

  it('skips documents with no text', async () => {
    const embedder = new FakeEmbedder();
    const index = await indexDocuments(embedder, [{ id: 'blank', text: '   ' }, ...docs]);
    expect(index.size).toBe(2);
  });
});
