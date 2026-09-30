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

import type { DocumentIdentifier, IdentifierField } from './identifiers.js';
import {
  asLabelProvenance,
  assertChunkBatch,
  keyIdentifierBatch,
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
  /** Canonical key to the value as first vaulted. */
  readonly #identifiers = new Map<string, string>();
  /** `documentHash + NUL + field` to canonical key. */
  readonly #mentions = new Map<string, string>();
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
    this.#dropMentions(contentHash);
    this.#dropOrphans();
  }

  /** Delete every identifier mention belonging to one document. */
  #dropMentions(documentHash: string): void {
    for (const mention of [...this.#mentions.keys()]) {
      if (mention.startsWith(`${documentHash}\u0000`)) this.#mentions.delete(mention);
    }
  }

  /** Delete identifiers no document mentions any more. */
  #dropOrphans(): void {
    const referenced = new Set(this.#mentions.values());
    for (const key of [...this.#identifiers.keys()]) {
      if (!referenced.has(key)) this.#identifiers.delete(key);
    }
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

  async putIdentifiers(
    documentHash: string,
    identifiers: readonly DocumentIdentifier[],
  ): Promise<void> {
    this.#assertOpen();
    const keyed = keyIdentifierBatch(identifiers);
    if (!this.#documents.has(documentHash)) {
      throw new StorageError(`No document ${documentHash} to attach identifiers to.`);
    }
    this.#dropMentions(documentHash);
    for (const { field, value, key } of keyed) {
      if (!this.#identifiers.has(key)) this.#identifiers.set(key, value);
      this.#mentions.set(`${documentHash}\u0000${field}`, key);
    }
    this.#dropOrphans();
  }

  async getIdentifier(documentHash: string, field: IdentifierField): Promise<string | null> {
    this.#assertOpen();
    const key = this.#mentions.get(`${documentHash}\u0000${field}`);
    return key === undefined ? null : (this.#identifiers.get(key) ?? null);
  }

  async purgeIdentifiers(): Promise<number> {
    this.#assertOpen();
    const count = this.#identifiers.size;
    this.#identifiers.clear();
    this.#mentions.clear();
    return count;
  }

  async countIdentifiers(): Promise<number> {
    this.#assertOpen();
    return this.#identifiers.size;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
