/**
 * The reveal path: reading one full identifier back out of the vault
 * (ADR-0011 section 3).
 *
 * Reading a full value is an explicit, per-item act: one document, one named
 * field. Nothing else in core calls `getIdentifier`, so the action queue,
 * scan output and retrieval cannot reach a full value by accident; they only
 * ever see the redacted extraction. Callers must not log what this returns.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { IDENTIFIER_FIELDS, type IdentifierField } from './identifiers.js';
import { contentHashOf } from './scan.js';
import type { StorageProvider, StoredDocument } from './storage-provider.js';

const FIELDS: ReadonlySet<string> = new Set<string>(Object.values(IDENTIFIER_FIELDS));

/**
 * Whether `value` names one of the extraction's identifier fields.
 *
 * Failure modes: none; pure.
 */
export function isIdentifierField(value: string): value is IdentifierField {
  return FIELDS.has(value);
}

/**
 * Find the stored document for a file the user names.
 *
 * The file is hashed as it is now, because the store is keyed by content: a
 * moved or renamed file is still found. Only when the file cannot be read
 * (deleted, or on a disconnected drive) does it fall back to the path the
 * document was last seen at. A file that exists but whose bytes changed since
 * the scan is not matched by path, since the stored row describes other
 * contents.
 *
 * Failure modes: resolves null when no stored document matches, which is not
 * an error. Rejects if the store is closed or a stored row cannot be parsed.
 */
export async function locateDocument(
  storage: StorageProvider,
  path: string,
): Promise<StoredDocument | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    const absolute = resolve(path);
    const all = await storage.listDocuments();
    return all.find((d) => d.path === absolute) ?? null;
  }
  return storage.getDocument(contentHashOf(bytes));
}

/** What a reveal found. Only `revealed` carries a full value. */
export type RevealResult =
  | { status: 'revealed'; field: IdentifierField; value: string }
  | {
      status: 'not_stored';
      field: IdentifierField;
      /** The redacted form from the stored extraction, or null when there is none. */
      redacted: string | null;
    }
  | {
      status: 'wrong_field';
      field: IdentifierField;
      /** The field this document's type does carry, or null when it has none. */
      documentField: IdentifierField | null;
    };

/**
 * Read the full vaulted value of one field of one stored document.
 *
 * Failure modes: resolves `wrong_field` when the document's type does not
 * carry that field, and `not_stored` when nothing is vaulted for it (the
 * setting is off, was off when the document was last scanned, or extraction
 * failed). Neither is an error. Rejects if the store is closed.
 */
export async function revealIdentifier(
  storage: StorageProvider,
  document: StoredDocument,
  field: IdentifierField,
): Promise<RevealResult> {
  const extraction = document.extraction;
  if (extraction) {
    const documentField = IDENTIFIER_FIELDS[extraction.type] ?? null;
    if (documentField !== field) return { status: 'wrong_field', field, documentField };
  }
  const value = await storage.getIdentifier(document.contentHash, field);
  if (value !== null) return { status: 'revealed', field, value };
  const stored = extraction ? (extraction as Record<string, unknown>)[field] : null;
  return { status: 'not_stored', field, redacted: typeof stored === 'string' ? stored : null };
}
