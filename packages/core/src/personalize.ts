/**
 * The personalization loop (ADR-0009 amendment 2, #67): the user corrects a
 * document's type, the correction becomes a labeled example, and the
 * classifier is built from the seeds plus every correction, so it adapts to
 * the user's recurring documents.
 *
 * Two rules from ADR-0011 and ADR-0012 shape this module:
 *
 * - A correction label is embedded from `derivedText` of the stored, redacted
 *   extraction: tokenized text, never a full identifier or its last four.
 *   The text is stored with the label so it can be re-embedded when the
 *   embedding model changes; the embedding itself is made lazily, the next
 *   time a classifier is built, so `outtray correct` never needs a model.
 * - A pinned type is sticky. When the stored extraction is of another type,
 *   the next scan extracts the document again under the pinned type's schema
 *   so the action layer reads the right fields.
 */

import type { TypeClassifier } from './classifier.js';
import { buildClassifier } from './classifier-seeds.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { DocumentType } from './extraction-schema.js';
import { derivedText } from './extraction-text.js';
import { type ReuseKeys, reusableDocument, reusedItem } from './incremental.js';
import { userVerdict } from './reconcile.js';
import type { ReuseAnswer } from './scan.js';
import type { StorageProvider, StoredDocument } from './storage-provider.js';

/** What a correction did. */
export interface CorrectionOutcome {
  /** True when the next scan extracts the document again under the pinned type. */
  reextract: boolean;
  /** True when a correction label was recorded; false when there was no extraction to learn from. */
  learned: boolean;
}

/**
 * Pin `type` on a stored document and record the correction as a labeled
 * example. Correcting the same document again replaces the earlier label.
 *
 * Failure modes: rejects if the store rejects a write. The document row is
 * written before the label, so a failure in between leaves the pin in place
 * and the label missing; correcting again records it.
 */
export async function correctDocument(
  storage: StorageProvider,
  document: StoredDocument,
  type: DocumentType,
): Promise<CorrectionOutcome> {
  const extraction = document.extraction;
  const vlmType = document.reconciliation?.vlmType ?? extraction?.type ?? null;
  await storage.putDocument({
    ...document,
    type,
    userType: type,
    // Review is only needed when nothing was extracted to read fields from.
    reconciliation: userVerdict(
      type,
      extraction ? vlmType : null,
      document.reconciliation?.classification ?? null,
    ),
  });
  if (extraction === null) {
    await storage.replaceDocumentLabels(document.contentHash, []);
    return { reextract: true, learned: false };
  }
  await storage.replaceDocumentLabels(document.contentHash, [
    {
      type,
      provenance: 'correction',
      documentHash: document.contentHash,
      text: derivedText(extraction),
      embedModel: null,
      embedding: [],
    },
  ]);
  return { reextract: extraction.type !== type, learned: true };
}

/**
 * The scan reuse hook with pins (ADR-0012, #67): reuse a current document,
 * extract a pinned document under its pinned type when its stored extraction
 * cannot be reused or is of another type, otherwise extract as usual.
 *
 * Failure modes: rejects if the store rejects a read.
 */
export async function reuseOrPin(
  storage: StorageProvider,
  file: string,
  contentHash: string,
  keys: ReuseKeys,
): Promise<ReuseAnswer> {
  const reusable = await reusableDocument(storage, contentHash, keys);
  if (reusable && (reusable.userType === null || reusable.extraction?.type === reusable.userType)) {
    return reusedItem(file, reusable);
  }
  const pinned = reusable?.userType ?? (await storage.getDocument(contentHash))?.userType ?? null;
  return pinned ? { extractAs: pinned } : null;
}

/**
 * A classifier of the shipped seeds plus every stored correction. Corrections
 * not yet embedded under `embedModel` are embedded in one call and saved, so
 * each is embedded once per model.
 *
 * Failure modes: rejects if the embedder or the store rejects. Seeds are
 * embedded on every call, as `buildClassifier` does.
 */
export async function personalClassifier(
  storage: StorageProvider,
  embedder: EmbeddingProvider,
  embedModel: string,
): Promise<TypeClassifier> {
  const classifier = await buildClassifier(embedder);
  const corrections = (await storage.listLabels()).filter(
    (l) => l.provenance === 'correction' && l.text !== null,
  );
  const stale = corrections.filter((l) => l.embedModel !== embedModel);
  if (stale.length > 0) {
    const vectors = await embedder.embed(stale.map((l) => l.text as string));
    for (const [i, label] of stale.entries()) {
      const vector = vectors[i] as number[];
      await storage.updateLabelEmbedding(label.id, vector, embedModel);
      label.embedding = vector;
    }
  }
  classifier.add(corrections.map((l) => ({ type: l.type, embedding: l.embedding })));
  return classifier;
}
