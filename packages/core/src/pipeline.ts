/**
 * The incremental scan, end to end, for any host (ADR-0012, ADR-0013).
 *
 * One function, so the CLI and the desktop app cannot drift: reuse unchanged
 * documents, extract new or pinned ones, classify with the seeds plus the
 * user's corrections, build the index on the write path, and save. The host
 * supplies the document source, the models and the store; everything that
 * decides what happens lives here.
 */

import type { DocumentSource } from './document-source.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { buildIndex, extractorKeyFor, indexKeyFor } from './incremental.js';
import type { ModelProvider } from './model-provider.js';
import { type PersistSummary, persistScan } from './persist.js';
import { personalClassifier, reuseOrPin } from './personalize.js';
import { type OcrRecognizer, type ScanReport, scanSource } from './scan.js';
import type { StorageProvider } from './storage-provider.js';

/** What `scanWithStore` needs from its host. */
export interface ScanWithStoreOptions {
  provider: ModelProvider;
  embedder: EmbeddingProvider;
  source: DocumentSource;
  /** The open store, or null to scan without one (nothing reused or saved). */
  storage: StorageProvider | null;
  /** The user's identifier-storage opt-in (ADR-0011). */
  identifierStorage: boolean;
  /** The extraction model tag, passed explicitly so the reuse key names it. */
  extractModel: string;
  /** The embedding model tag, for the index key and label embeddings. */
  embedModel: string;
  /**
   * Read new documents' text first and classify from it (ADR-0009 amendment
   * 3). Omit to scan as before; turning it on or off changes the extractor
   * key, so every stored document is extracted once more.
   */
  ocr?: OcrRecognizer;
}

/** What a scan did. */
export interface ScanWithStoreResult {
  report: ScanReport;
  /** What was saved, or null when there was no store or saving failed. */
  saved: PersistSummary | null;
  /** Why the index was not updated, or null. Documents are still saved. */
  indexError: string | null;
  /** Why saving failed, or null. The report stands either way. */
  saveError: unknown;
}

/**
 * Scan `source` incrementally against `storage` and save the result.
 *
 * Failure modes: rejects only when the scan itself fails (the vision model is
 * unreachable for a file that needs extracting); the caller still owns and
 * closes the store. A failure while saving resolves with `saveError` set, and
 * an embedder failure with `indexError` set, because the store is a cache and
 * the report is what the user asked for.
 */
export async function scanWithStore(options: ScanWithStoreOptions): Promise<ScanWithStoreResult> {
  const { provider, embedder, source, storage, identifierStorage } = options;
  const keys = {
    extractorKey: extractorKeyFor(options.extractModel, options.ocr?.key),
    indexKey: indexKeyFor(options.embedModel),
    identifierStorage,
  };
  const report = await scanSource(provider, source, {
    model: options.extractModel,
    ...(options.ocr ? { ocr: options.ocr } : {}),
    classify: {
      embedder,
      // Seeds plus the user's corrections (#67), built only if needed.
      ...(storage
        ? { classifier: () => personalClassifier(storage, embedder, options.embedModel) }
        : {}),
    },
    ...(storage
      ? { reuse: (file: string, hash: string) => reuseOrPin(storage, file, hash, keys) }
      : {}),
  });
  if (storage === null) return { report, saved: null, indexError: null, saveError: null };

  try {
    const built = await buildIndex(embedder, report);
    const saved = await persistScan(storage, report, {
      locate: source.locate,
      identifierStorage,
      extractorKey: keys.extractorKey,
      ...(built.error === null ? { index: { key: keys.indexKey, chunks: built.chunks } } : {}),
    });
    return { report, saved, indexError: built.error, saveError: null };
  } catch (error) {
    return { report, saved: null, indexError: null, saveError: error };
  }
}
