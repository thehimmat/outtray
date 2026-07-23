/**
 * Retrieval over document chunks with citations (ADR-0005).
 *
 * Chunks are embedded and ranked against a query with the in-TypeScript
 * brute-force cosine scan (`vector.ts`); no native vector extension, which is
 * fast enough for a personal corpus and keeps Tauri packaging simple. Every
 * retrieved passage carries a `SourceRef` (document id, page, chunk index) so
 * the planner can cite exactly where an action came from. This is the retrieval
 * plumbing; user-facing Q&A is deferred (a CLI subcommand at most).
 */

import { type Chunk, type ChunkOptions, chunkText } from './chunk.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { rankBySimilarity } from './vector.js';

/** A document to index: an id, its text, and an optional page number. */
export interface DocumentText {
  id: string;
  text: string;
  page?: number;
}

/** Where a chunk came from, for citation. */
export interface SourceRef {
  documentId: string;
  page: number | undefined;
  chunkIndex: number;
}

/** A chunk with its embedding and source. */
export interface IndexedChunk {
  text: string;
  embedding: number[];
  source: SourceRef;
}

/** A retrieved passage with its source and similarity score. */
export interface Citation {
  text: string;
  source: SourceRef;
  score: number;
}

/** An in-memory index of embedded chunks, ranked by brute-force cosine. */
export class VectorIndex {
  readonly #chunks: IndexedChunk[] = [];

  /** Add embedded chunks to the index. */
  add(chunks: IndexedChunk[]): void {
    this.#chunks.push(...chunks);
  }

  /** Number of indexed chunks. */
  get size(): number {
    return this.#chunks.length;
  }

  /**
   * Return the top `k` chunks most similar to `queryEmbedding`, as citations.
   *
   * Failure modes: returns `[]` for an empty index. Propagates `RangeError`
   * from the cosine scan if the query dimension does not match the chunks'.
   */
  retrieve(queryEmbedding: number[], k: number): Citation[] {
    if (this.#chunks.length === 0) return [];
    const ranked = rankBySimilarity(
      queryEmbedding,
      this.#chunks.map((c) => c.embedding),
    );
    return ranked.slice(0, k).map(({ index, score }) => {
      const chunk = this.#chunks[index] as IndexedChunk;
      return { text: chunk.text, source: chunk.source, score };
    });
  }
}

/**
 * Chunk and embed documents into a `VectorIndex`.
 *
 * Failure modes: rejects if the embedder rejects. Documents whose text is empty
 * after chunking are skipped, not errors. Embeds one document's chunks per call
 * to the embedder.
 */
export async function indexDocuments(
  embedder: EmbeddingProvider,
  docs: DocumentText[],
  options?: ChunkOptions,
): Promise<VectorIndex> {
  const index = new VectorIndex();
  for (const doc of docs) {
    const pieces: Chunk[] = chunkText(doc.text, options);
    if (pieces.length === 0) continue;
    const embeddings = await embedder.embed(pieces.map((p) => p.text));
    index.add(
      pieces.map((piece, i) => ({
        text: piece.text,
        embedding: embeddings[i] as number[],
        source: { documentId: doc.id, page: doc.page, chunkIndex: piece.index },
      })),
    );
  }
  return index;
}

/**
 * Embed a query and return the top `k` cited passages from the index.
 *
 * Failure modes: rejects if the embedder rejects; returns `[]` if the embedder
 * yields no vector for the query.
 */
export async function search(
  index: VectorIndex,
  embedder: EmbeddingProvider,
  query: string,
  k: number,
): Promise<Citation[]> {
  const [queryEmbedding] = await embedder.embed([query]);
  if (!queryEmbedding) return [];
  return index.retrieve(queryEmbedding, k);
}
