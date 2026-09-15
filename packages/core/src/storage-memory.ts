/**
 * In-memory `StorageProvider` (ADR-0011).
 *
 * The reason the interface exists: everything above the persistence seam stays
 * unit-testable without compiling a native module, and CI can exercise the
 * domain logic even where the SQLCipher adapter is not the thing under test.
 *
 * It is deliberately a faithful stand-in rather than a convenience: it enforces
 * the same batch rules, returns the same orderings, and rejects the same
 * inputs, so `storage-contract.test.ts` can hold both implementations to one
 * suite. Nothing here is encrypted and nothing survives the process, which is
 * the whole point.
 */

import {
  asLabelProvenance,
  assertChunkBatch,
  type NewLabel,
  StorageError,
  type StorageProvider,
  type StoredChunk,
  type StoredDocument,
  type StoredLabel,
} from './storage-provider.js';

/** Deep-copy a record so callers cannot mutate what the store holds. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStorage implements StorageProvider {
  readonly name = 'memory';
  readonly #documents = new Map<string, StoredDocument>();
  readonly #chunks = new Map<string, StoredChunk[]>();
  readonly #labels: StoredLabel[] = [];
  #nextLabelId = 1;
  #closed = false;

  #assertOpen(): void {
    if (this.#closed) {
      throw new StorageError('Storage is closed.');
    }
  }

  async putDocument(document: StoredDocument): Promise<void> {
    this.#assertOpen();
    this.#documents.set(document.contentHash, clone(document));
  }

  async getDocument(contentHash: string): Promise<StoredDocument | null> {
    this.#assertOpen();
    const found = this.#documents.get(contentHash);
    return found ? clone(found) : null;
  }

  async listDocuments(): Promise<StoredDocument[]> {
    this.#assertOpen();
    return [...this.#documents.values()]
      .sort((a, b) => (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0))
      .map(clone);
  }

  async deleteDocument(contentHash: string): Promise<void> {
    this.#assertOpen();
    this.#documents.delete(contentHash);
    this.#chunks.delete(contentHash);
  }

  async putChunks(contentHash: string, chunks: StoredChunk[]): Promise<void> {
    this.#assertOpen();
    assertChunkBatch(contentHash, chunks);
    if (!this.#documents.has(contentHash)) {
      throw new StorageError(`No document ${contentHash} to attach chunks to.`);
    }
    this.#chunks.set(
      contentHash,
      [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex).map(clone),
    );
  }

  async listChunks(): Promise<StoredChunk[]> {
    this.#assertOpen();
    return [...this.#chunks.keys()]
      .sort()
      .flatMap((hash) => this.#chunks.get(hash) ?? [])
      .map(clone);
  }

  async addLabels(labels: NewLabel[]): Promise<StoredLabel[]> {
    this.#assertOpen();
    if (labels.length === 0) return [];
    for (const label of labels) asLabelProvenance(label.provenance);
    const stored = labels.map((label) => ({ ...clone(label), id: this.#nextLabelId++ }));
    this.#labels.push(...stored);
    return stored.map(clone);
  }

  async listLabels(): Promise<StoredLabel[]> {
    this.#assertOpen();
    return [...this.#labels].sort((a, b) => a.id - b.id).map(clone);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
