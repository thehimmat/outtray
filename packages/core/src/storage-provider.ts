/**
 * The seam through which all persistence flows (ADR-0011).
 *
 * A third provider interface alongside `ModelProvider` and `EmbeddingProvider`,
 * for the same reason: domain logic depends on the interface, the native
 * SQLCipher module sits behind it as an adapter at the edge, and
 * `MemoryStorage` keeps everything above it unit-testable without compiling
 * anything. Phase 3 swaps the adapter without touching planning, retrieval or
 * classification.
 *
 * Every method is async even though the SQLCipher adapter is synchronous
 * underneath. The interface has to survive a Phase 3 implementation on the far
 * side of Tauri IPC, and widening a synchronous signature later would mean
 * changing every caller.
 *
 * What this store is: a derived cache of the user's documents, which are never
 * modified and remain the source of truth (ADR-0007, ADR-0008). Losing it
 * costs a re-scan, not data. No surface may present it as a backup.
 */

import type { DocumentExtraction, DocumentType } from './extraction-schema.js';
import type { Reconciliation } from './reconcile.js';

/** Where a label came from: a shipped seed, or the user correcting the app. */
export type LabelProvenance = 'seed' | 'correction';

/** One scanned document, keyed by the hash of its contents. */
export interface StoredDocument {
  /** Content hash of the file. Primary key; a moved file is the same document. */
  contentHash: string;
  /** Absolute path where the file was last seen. Indexed in place, never copied. */
  path: string;
  /** The working type after reconciliation, or null when nothing was trusted. */
  type: DocumentType | null;
  /** The validated extraction, or null when extraction produced nothing usable. */
  extraction: DocumentExtraction | null;
  /** The ADR-0009 verdict, or null when the classification stage did not run. */
  reconciliation: Reconciliation | null;
  /** When the document was last scanned, in milliseconds since the epoch. */
  scannedAt: number;
}

/**
 * One chunk of a document's derived text with its embedding.
 *
 * `text` is derived text, so it is the tokenized form: known identifier values
 * are replaced before the chunk is written (ADR-0011 section 3). The tokenizer
 * lands with the identifier vault; until then the store persists whatever text
 * it is handed, and callers are not yet wired up.
 */
export interface StoredChunk {
  /** Content hash of the document this chunk came from. */
  documentHash: string;
  /** Position of the chunk within the document, from zero. */
  chunkIndex: number;
  /** Page the chunk came from, or null when the source has no pages. */
  page: number | null;
  /** Tokenized chunk text. */
  text: string;
  /** The chunk's embedding. Round-trips through float32; see `putChunks`. */
  embedding: number[];
}

/** A classifier training example: a seed, or a correction the user made. */
export interface StoredLabel {
  /** Assigned by the store on insert. */
  id: number;
  type: DocumentType;
  /** The example's embedding. Round-trips through float32; see `addLabels`. */
  embedding: number[];
  provenance: LabelProvenance;
}

/** A label before the store has assigned it an id. */
export type NewLabel = Omit<StoredLabel, 'id'>;

/** A swappable persistence backend (ADR-0011). */
export interface StorageProvider {
  /** Stable identifier for logs, e.g. `sqlcipher`. */
  readonly name: string;

  /**
   * Insert a document, or replace the one with the same content hash.
   *
   * Failure modes: rejects if the store is closed or the underlying database
   * rejects the write. Replacing a document leaves its chunks alone, because a
   * re-scan writes the document row before it has re-chunked anything; use
   * `putChunks` to replace those.
   */
  putDocument(document: StoredDocument): Promise<void>;

  /**
   * Fetch one document by content hash.
   *
   * Failure modes: resolves null when no such document exists, which is not an
   * error. Rejects if the store is closed, or if the stored extraction or
   * reconciliation JSON cannot be parsed (a corrupt row is not silently
   * treated as an absent one).
   */
  getDocument(contentHash: string): Promise<StoredDocument | null>;

  /**
   * Every document, ordered by content hash so the order is stable.
   *
   * Failure modes: as `getDocument`. Resolves an empty array for an empty store.
   */
  listDocuments(): Promise<StoredDocument[]>;

  /**
   * Delete a document and its chunks.
   *
   * Failure modes: deleting a document that is not there is a no-op, not an
   * error. Rejects if the store is closed.
   */
  deleteDocument(contentHash: string): Promise<void>;

  /**
   * Replace all chunks of one document, atomically.
   *
   * Replace rather than append: re-chunking a document must not leave the
   * previous run's chunks behind to be retrieved alongside the new ones.
   *
   * Failure modes: rejects if any chunk's `documentHash` differs from
   * `contentHash`, if the document does not exist (chunks reference it), or if
   * two chunks share a `chunkIndex`. Rejects if the store is closed. Nothing is
   * written when it rejects. Embeddings are stored as float32, so values read
   * back are not bit-identical to float64 input; this matches how the spike
   * measured the index and is below the noise of cosine ranking.
   */
  putChunks(contentHash: string, chunks: StoredChunk[]): Promise<void>;

  /**
   * Every chunk, ordered by document hash then chunk index.
   *
   * This is the whole-index read the brute-force cosine scan needs (ADR-0005);
   * the spike measured it at 77 ms for 5000 chunks.
   *
   * Failure modes: rejects if the store is closed. Resolves an empty array when
   * nothing has been chunked.
   */
  listChunks(): Promise<StoredChunk[]>;

  /**
   * Append classifier labels and return them with their assigned ids.
   *
   * Failure modes: rejects if the store is closed or a label's provenance is
   * not a `LabelProvenance`. Nothing is written when it rejects. Resolves an
   * empty array for empty input without touching the database. Appends: the
   * store does not deduplicate, because two corrections of the same document
   * are two data points.
   */
  addLabels(labels: NewLabel[]): Promise<StoredLabel[]>;

  /**
   * Every label, ordered by id, so seeds precede the corrections that followed.
   *
   * Failure modes: rejects if the store is closed. Resolves an empty array for
   * an empty store.
   */
  listLabels(): Promise<StoredLabel[]>;

  /**
   * Close the store and release its handle.
   *
   * Failure modes: closing twice is a no-op, not an error. Every other method
   * rejects after this resolves.
   */
  close(): Promise<void>;
}

/** Thrown when a store is used after `close`, or when a write is inconsistent. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Validate a `putChunks` batch against its document.
 *
 * Shared by every implementation so the in-memory store and the SQLCipher store
 * cannot drift on what they accept.
 *
 * Failure modes: throws `StorageError` if any chunk belongs to another document
 * or if two chunks share a `chunkIndex`. Pure; accepts an empty batch.
 */
export function assertChunkBatch(contentHash: string, chunks: readonly StoredChunk[]): void {
  const seen = new Set<number>();
  for (const chunk of chunks) {
    if (chunk.documentHash !== contentHash) {
      throw new StorageError(
        `Chunk belongs to document ${chunk.documentHash}, not ${contentHash}.`,
      );
    }
    if (seen.has(chunk.chunkIndex)) {
      throw new StorageError(
        `Duplicate chunk index ${chunk.chunkIndex} for document ${contentHash}.`,
      );
    }
    seen.add(chunk.chunkIndex);
  }
}

/** Provenance values the store accepts. */
const PROVENANCES: ReadonlySet<string> = new Set<LabelProvenance>(['seed', 'correction']);

/**
 * Narrow a stored string to a `LabelProvenance`.
 *
 * Failure modes: throws `StorageError` for anything else, so a hand-edited or
 * future-version row surfaces rather than being coerced to `seed`.
 */
export function asLabelProvenance(value: string): LabelProvenance {
  if (!PROVENANCES.has(value)) {
    throw new StorageError(`Unknown label provenance: ${value}.`);
  }
  return value as LabelProvenance;
}
