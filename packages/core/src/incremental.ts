/**
 * Incremental scanning and the persisted retrieval index (ADR-0012, #43).
 *
 * Three pieces, kept together because they share one invariant: the store
 * holds only redacted extractions, so anything derived from a full
 * extraction (chunk text, embeddings) must be built while the full extraction
 * is still in memory, and a stored extraction is only reused when the chunks
 * built from it are current too.
 *
 * - `reusableDocument` decides whether a scanned file can skip the model.
 * - `buildIndex` chunks and embeds freshly extracted documents on the scan
 *   write path, from their tokenized text.
 * - `searchStore` answers a query from stored chunks, embedding only the
 *   query.
 */

import { CHUNKER_VERSION, type ChunkOptions, chunkText } from './chunk.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { PROMPT_VERSION, TYPED_PROMPT_VERSION } from './extract.js';
import { extractionText } from './extraction-text.js';
import { IDENTIFIER_FIELDS, TOKENIZER_VERSION, tokenizeExtraction } from './identifiers.js';
import { reconcileType } from './reconcile.js';
import type { Citation } from './retrieval.js';
import type { ScanItem, ScanReport } from './scan.js';
import type { StorageProvider, StoredChunk, StoredDocument } from './storage-provider.js';
import { rankBySimilarity } from './vector.js';

/**
 * The extractor key for a model tag: the model plus both prompt versions.
 *
 * Failure modes: none; pure.
 */
export function extractorKeyFor(model: string): string {
  return `${model}|${PROMPT_VERSION}|${TYPED_PROMPT_VERSION}`;
}

/**
 * The index key for an embedding model: the model plus the chunker and
 * tokenizer versions that shape chunk text.
 *
 * Failure modes: none; pure.
 */
export function indexKeyFor(embeddingModel: string): string {
  return `${embeddingModel}|${CHUNKER_VERSION}|${TOKENIZER_VERSION}`;
}

/** What `reusableDocument` compares a stored document against. */
export interface ReuseKeys {
  extractorKey: string;
  indexKey: string;
  /** The user's opt-in; on means a document must have its identifier vaulted. */
  identifierStorage: boolean;
}

/**
 * The stored document for `contentHash` when it may be reused instead of
 * extracted again, else null (ADR-0012 section 2): it must exist with an
 * extraction, both version keys must match, and with identifier storage on a
 * document whose type carries an identifier must already have it vaulted.
 *
 * Failure modes: resolves null for anything not reusable, which is not an
 * error. Rejects if the store is closed or a stored row cannot be parsed.
 */
export async function reusableDocument(
  storage: StorageProvider,
  contentHash: string,
  keys: ReuseKeys,
): Promise<StoredDocument | null> {
  const doc = await storage.getDocument(contentHash);
  if (doc === null || doc.extraction === null) return null;
  if (doc.extractorKey !== keys.extractorKey || doc.indexKey !== keys.indexKey) return null;
  if (keys.identifierStorage) {
    const field = IDENTIFIER_FIELDS[doc.extraction.type];
    if (field && !(await storage.identifierFields(contentHash)).includes(field)) return null;
  }
  return doc;
}

const NO_USAGE = { loadMs: 0, promptTokens: 0, genTokens: 0, genTokPerSec: null, totalMs: 0 };

/**
 * A scan item rebuilt from a reusable stored document, marked `reused`. Its
 * document is the stored redacted extraction; its verdict is the stored one,
 * or unclassified when none was stored.
 *
 * Failure modes: none; pure. Callers pass only documents `reusableDocument`
 * returned, which always have an extraction.
 */
export function reusedItem(file: string, doc: StoredDocument): ScanItem {
  const extraction = doc.extraction;
  return {
    file,
    contentHash: doc.contentHash,
    result: {
      valid: extraction !== null,
      jsonChannel: null,
      raw: null,
      usage: NO_USAGE,
      error: extraction === null ? 'no stored extraction' : null,
      document: extraction,
    },
    reconciliation: doc.reconciliation ?? reconcileType(extraction?.type ?? null, null),
    reused: true,
  };
}

/** Chunks built for a scan, by content hash, and why there are none if it failed. */
export interface BuiltIndex {
  chunks: Map<string, StoredChunk[]>;
  /** The embedder's failure, or null when it ran (or had nothing to do). */
  error: string | null;
}

/**
 * Chunk and embed every freshly extracted document in `report`, from its
 * tokenized text, in one embedder call (ADR-0012 section 3). Reused items and
 * failed extractions are skipped.
 *
 * Failure modes: never rejects. An embedder failure resolves an empty map
 * with the reason, so the scan's documents are still saved and are simply
 * extracted again next time. Documents whose text chunks to nothing get no
 * entry.
 */
export async function buildIndex(
  embedder: EmbeddingProvider,
  report: ScanReport,
  options?: ChunkOptions,
): Promise<BuiltIndex> {
  const pending: Array<{ hash: string; index: number; text: string }> = [];
  for (const item of report.items) {
    const doc = item.result.document;
    if (item.reused || !doc) continue;
    // Derived text is built tokenized, never with a full identifier (ADR-0011).
    for (const piece of chunkText(extractionText(tokenizeExtraction(doc)), options)) {
      pending.push({ hash: item.contentHash, index: piece.index, text: piece.text });
    }
  }
  const chunks = new Map<string, StoredChunk[]>();
  if (pending.length === 0) return { chunks, error: null };

  let vectors: number[][];
  try {
    vectors = await embedder.embed(pending.map((p) => p.text));
  } catch (error) {
    return { chunks, error: error instanceof Error ? error.message : String(error) };
  }
  pending.forEach((p, i) => {
    const list = chunks.get(p.hash) ?? [];
    list.push({
      documentHash: p.hash,
      chunkIndex: p.index,
      page: null,
      text: p.text,
      embedding: vectors[i] as number[],
    });
    chunks.set(p.hash, list);
  });
  return { chunks, error: null };
}

/** Which stored chunks a query may draw on. */
export interface SearchScope {
  /** Content hash to the name cited for it (the file name in the scanned folder). */
  documents: ReadonlyMap<string, string>;
  /** Only chunks of documents indexed under this key are ranked. */
  indexKey: string;
}

/**
 * Embed `query` and return the top `k` stored chunks of the documents in
 * `scope`, cited by their display name (ADR-0012 section 4).
 *
 * Failure modes: rejects if the store or the embedder rejects. Resolves `[]`
 * without embedding the query when no chunk is in scope, so an empty search
 * never loads a model. Propagates `RangeError` if stored embeddings and the
 * query differ in dimension, which the index key is there to prevent.
 */
export async function searchStore(
  storage: StorageProvider,
  embedder: EmbeddingProvider,
  query: string,
  k: number,
  scope: SearchScope,
): Promise<Citation[]> {
  const current = new Set(
    (await storage.listDocuments())
      .filter((d) => scope.documents.has(d.contentHash) && d.indexKey === scope.indexKey)
      .map((d) => d.contentHash),
  );
  const chunks = (await storage.listChunks()).filter((c) => current.has(c.documentHash));
  if (chunks.length === 0) return [];
  const [vector] = await embedder.embed([query]);
  if (!vector) return [];
  return rankBySimilarity(
    vector,
    chunks.map((c) => c.embedding),
  )
    .slice(0, k)
    .map(({ index, score }) => {
      const chunk = chunks[index] as StoredChunk;
      return {
        text: chunk.text,
        score,
        source: {
          documentId: scope.documents.get(chunk.documentHash) ?? chunk.documentHash,
          page: chunk.page ?? undefined,
          chunkIndex: chunk.chunkIndex,
        },
      };
    });
}
