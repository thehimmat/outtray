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
import {
  canonicalIdentifier,
  type DocumentIdentifier,
  IDENTIFIER_FIELDS,
  type IdentifierField,
} from './identifiers.js';
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
 * `text` is derived text, so it is the tokenized form: callers build it from
 * `tokenizeExtraction` (identifiers.ts), which replaces identifier values with
 * a `[field]` placeholder (ADR-0011 section 3 and amendment). The store
 * persists whatever text it is handed; nothing writes chunks until #43.
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
   * Delete a document, its chunks, its identifier mentions, and any vaulted
   * identifier that no remaining document mentions.
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
   * Replace the vaulted identifiers of one document, atomically (ADR-0011
   * section 3). Replace rather than add, as `putChunks` does: a re-scan that
   * no longer finds an identifier, or finds it under another field, must not
   * leave the old value attached and revealable. An empty batch clears them.
   *
   * Each value is stored once per canonical form (separators and case
   * removed), however many documents mention it. An identifier no document
   * mentions any more is deleted, so no copy outlives its last reference.
   *
   * Callers write here only when the user has opted in to identifier storage;
   * the store does not know the setting.
   *
   * Failure modes: rejects with `StorageError` if the document does not exist,
   * if a field is not an identifier field or appears twice, or if a value has
   * no letters or digits. Rejects if the store is closed. Nothing is written
   * when it rejects.
   */
  putIdentifiers(documentHash: string, identifiers: readonly DocumentIdentifier[]): Promise<void>;

  /**
   * The full vaulted value for one field of one document: the reveal path. It
   * is the value as first vaulted, so a later mention in another format reads
   * back in the first format.
   *
   * Failure modes: resolves null when nothing is vaulted for that pair, which
   * is not an error (identifier storage is off by default). Rejects if the
   * store is closed.
   */
  getIdentifier(documentHash: string, field: IdentifierField): Promise<string | null>;

  /**
   * Delete every vaulted identifier and every mention of one, leaving
   * documents, chunks and labels untouched. This is what switching identifier
   * storage off does, and it is complete by construction because the vault
   * table is the only place a full value is stored (ADR-0011 amendment).
   *
   * Failure modes: rejects if the store is closed. Resolves the number of
   * identifiers deleted; 0 for an empty vault.
   */
  purgeIdentifiers(): Promise<number>;

  /**
   * How many distinct identifiers are vaulted.
   *
   * Failure modes: rejects if the store is closed.
   */
  countIdentifiers(): Promise<number>;

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

const IDENTIFIER_FIELD_SET: ReadonlySet<string> = new Set<string>(Object.values(IDENTIFIER_FIELDS));

/** One validated `putIdentifiers` entry with the canonical key it is stored under. */
export interface KeyedIdentifier extends DocumentIdentifier {
  key: string;
}

/**
 * Validate a `putIdentifiers` batch and key each entry by its canonical form.
 * Shared by every implementation so they cannot drift on what they accept.
 *
 * Failure modes: throws `StorageError` for a field that is not an identifier
 * field or appears twice, or a value with no letters or digits. Pure; accepts
 * an empty batch.
 */
export function keyIdentifierBatch(identifiers: readonly DocumentIdentifier[]): KeyedIdentifier[] {
  const seen = new Set<string>();
  return identifiers.map(({ field, value }) => {
    if (!IDENTIFIER_FIELD_SET.has(field)) {
      throw new StorageError(`Not an identifier field: ${field}.`);
    }
    if (seen.has(field)) {
      throw new StorageError(`Identifier field ${field} appears twice in one batch.`);
    }
    seen.add(field);
    const key = canonicalIdentifier(value);
    if (key === '') {
      throw new StorageError(`Refusing to vault a blank ${field}.`);
    }
    return { field, value, key };
  });
}
