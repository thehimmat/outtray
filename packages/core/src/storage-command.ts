/**
 * A `StorageProvider` that sends one JSON command per method to a store on
 * the far side of a transport (ADR-0013).
 *
 * In the desktop app the transport is Tauri's `invoke`, and the commands run
 * in the Rust store (`packages/app/store`). In tests it is a stdio pipe to
 * the same Rust code, so the shared contract suite holds the Rust store to
 * exactly the behaviour of the two TypeScript stores.
 *
 * Validation shared by every store (chunk batches, identifier keys, label
 * provenance and ownership) runs here, before a command is sent, by the same
 * functions the other stores call. Stored rows are checked on the way back
 * (document types, label provenance), so a bad row surfaces as an error
 * rather than an untyped value.
 */

import type { DocumentType } from './extraction-schema.js';
import { DOCUMENT_TYPES } from './extraction-schema.js';
import type { DocumentIdentifier, IdentifierField } from './identifiers.js';
import { DatabaseKeyError, StorageCorruptError } from './storage-errors.js';
import { StorageFormatError } from './storage-format.js';
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
  type StoredReview,
} from './storage-provider.js';
import { StorageMigrationError } from './storage-schema.js';

/**
 * Sends one command and resolves its result. A failed command rejects with an
 * object carrying `kind` (`storage`, `corrupt`, `key`, `format`, `migration`
 * or `protocol`) and `message`.
 */
export type StorageTransport = (op: string, args: Record<string, unknown>) => Promise<unknown>;

const TYPES: ReadonlySet<string> = new Set<string>(DOCUMENT_TYPES);

/** Map a transport failure to the error class the other stores throw. */
function toStorageError(failure: unknown, path: string): Error {
  const { kind, message } = (failure ?? {}) as { kind?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message : String(failure);
  switch (kind) {
    case 'corrupt':
      return new StorageCorruptError(path, text);
    case 'key':
      return new DatabaseKeyError(text);
    case 'format':
      return new StorageFormatError(text);
    case 'migration':
      return new StorageMigrationError(text);
    default:
      return new StorageError(text);
  }
}

function asType(value: unknown): DocumentType | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !TYPES.has(value)) {
    throw new StorageError(`Unknown document type in the store: ${String(value)}.`);
  }
  return value as DocumentType;
}

function document(row: unknown): StoredDocument {
  const d = row as StoredDocument;
  return { ...d, type: asType(d.type), userType: asType(d.userType) };
}

function label(row: unknown): StoredLabel {
  const l = row as StoredLabel;
  const type = asType(l.type);
  if (type === null) throw new StorageError('A stored label has no type.');
  return { ...l, type, provenance: asLabelProvenance(l.provenance) };
}

/**
 * Open the store on the far side of `transport`. `options` are for transports
 * that take the location and key from the caller (the stdio test binary);
 * the desktop app omits them, because its Rust side reads the key from the
 * Keychain and it never reaches JavaScript (ADR-0013).
 *
 * Failure modes: rejects with `StorageCorruptError`, `DatabaseKeyError`,
 * `StorageFormatError` or `StorageMigrationError` as the TypeScript store
 * would for the same file, or `StorageError` for anything else.
 */
export async function openCommandStorage(
  transport: StorageTransport,
  options: { path?: string; keyHex?: string } = {},
): Promise<CommandStorage> {
  const path = options.path ?? 'the encrypted store';
  try {
    await transport('open', { ...options });
  } catch (failure) {
    throw toStorageError(failure, path);
  }
  return new CommandStorage(transport, path);
}

/** The store, reached through commands. Construct it with `openCommandStorage`. */
export class CommandStorage implements StorageProvider {
  readonly name = 'command';
  readonly #send: StorageTransport;
  readonly #path: string;
  #closed = false;

  /** @internal Use `openCommandStorage`. */
  constructor(transport: StorageTransport, path: string) {
    this.#send = transport;
    this.#path = path;
  }

  async #call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed) throw new StorageError('Storage is closed.');
    try {
      return await this.#send(op, args);
    } catch (failure) {
      throw toStorageError(failure, this.#path);
    }
  }

  async putDocument(doc: StoredDocument): Promise<void> {
    await this.#call('putDocument', { document: doc });
  }

  async getDocument(contentHash: string): Promise<StoredDocument | null> {
    const row = await this.#call('getDocument', { contentHash });
    return row === null ? null : document(row);
  }

  async listDocuments(): Promise<StoredDocument[]> {
    return ((await this.#call('listDocuments')) as unknown[]).map(document);
  }

  async deleteDocument(contentHash: string): Promise<void> {
    await this.#call('deleteDocument', { contentHash });
  }

  async putChunks(contentHash: string, chunks: StoredChunk[]): Promise<void> {
    if (this.#closed) throw new StorageError('Storage is closed.');
    assertChunkBatch(contentHash, chunks);
    await this.#call('putChunks', { contentHash, chunks });
  }

  async listChunks(): Promise<StoredChunk[]> {
    return (await this.#call('listChunks')) as StoredChunk[];
  }

  async addLabels(labels: NewLabel[]): Promise<StoredLabel[]> {
    if (this.#closed) throw new StorageError('Storage is closed.');
    if (labels.length === 0) return [];
    for (const l of labels) asLabelProvenance(l.provenance);
    return ((await this.#call('addLabels', { labels })) as unknown[]).map(label);
  }

  async listLabels(): Promise<StoredLabel[]> {
    return ((await this.#call('listLabels')) as unknown[]).map(label);
  }

  async replaceDocumentLabels(documentHash: string, labels: NewLabel[]): Promise<void> {
    if (this.#closed) throw new StorageError('Storage is closed.');
    for (const l of labels) {
      asLabelProvenance(l.provenance);
      if (l.documentHash !== documentHash) {
        throw new StorageError(`Label belongs to ${l.documentHash}, not ${documentHash}.`);
      }
    }
    await this.#call('replaceDocumentLabels', { documentHash, labels });
  }

  async updateLabelEmbedding(id: number, embedding: number[], embedModel: string): Promise<void> {
    await this.#call('updateLabelEmbedding', { id, embedding, embedModel });
  }

  async putIdentifiers(
    documentHash: string,
    identifiers: readonly DocumentIdentifier[],
  ): Promise<void> {
    if (this.#closed) throw new StorageError('Storage is closed.');
    const keyed = keyIdentifierBatch(identifiers);
    await this.#call('putIdentifiers', { documentHash, identifiers: keyed });
  }

  async getIdentifier(documentHash: string, field: IdentifierField): Promise<string | null> {
    return (await this.#call('getIdentifier', { documentHash, field })) as string | null;
  }

  async identifierFields(documentHash: string): Promise<IdentifierField[]> {
    return (await this.#call('identifierFields', { documentHash })) as IdentifierField[];
  }

  async purgeIdentifiers(): Promise<number> {
    return (await this.#call('purgeIdentifiers')) as number;
  }

  async countIdentifiers(): Promise<number> {
    return (await this.#call('countIdentifiers')) as number;
  }

  async setReview(review: StoredReview): Promise<void> {
    await this.#call('setReview', { review });
  }

  async clearReview(key: string): Promise<void> {
    await this.#call('clearReview', { key });
  }

  async listReviews(): Promise<StoredReview[]> {
    return (await this.#call('listReviews')) as StoredReview[];
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#call('close');
    this.#closed = true;
  }
}
