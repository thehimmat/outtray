/**
 * The retrieval demo flow: scan a folder, index the extractions, and return
 * cited passages for a query (Phase 2, ADR-0005).
 *
 * This is the plumbing behind the `outtray find` subcommand. It runs the VLM
 * extraction over a folder, turns each document's structured extraction into a
 * text representation, embeds and indexes those, and searches. Extraction and
 * embedding use different models, run sequentially, so only one is resident at
 * a time (ADR-0002). Full OCR text (the Apple Vision arm) lands later; for now
 * the extraction itself is the indexed text.
 */

import type { ChunkOptions } from './chunk.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { DocumentExtraction } from './extraction-schema.js';
import type { ModelProvider } from './model-provider.js';
import { type Citation, type DocumentText, indexDocuments, search } from './retrieval.js';
import { type ScanOptions, type ScanReport, scanDirectory } from './scan.js';

/** Flatten a structured extraction into text for retrieval. */
export function extractionText(doc: DocumentExtraction): string {
  const parts: string[] = [doc.summary];
  for (const item of doc.action_items) parts.push(item.text);
  for (const [key, value] of Object.entries(doc)) {
    if (key !== 'type' && key !== 'summary' && typeof value === 'string') {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.filter((p) => p.trim() !== '').join('. ');
}

export interface FindOptions {
  /** Model tag for extraction (passed through to the scan). */
  model?: string;
  scan?: ScanOptions;
  chunk?: ChunkOptions;
}

/** The result of a find: the ranked citations and the underlying scan report. */
export interface FindResult {
  citations: Citation[];
  scanned: ScanReport;
}

/**
 * Scan `dir`, index the extracted documents, and return the top `k` cited
 * passages for `query`.
 *
 * Failure modes: rejects if the directory cannot be read or either provider
 * rejects (e.g. a runtime is unreachable). Documents that fail extraction are
 * simply absent from the index, not errors; a query with nothing to match
 * returns `[]`.
 */
export async function findInDirectory(
  model: ModelProvider,
  embedder: EmbeddingProvider,
  dir: string,
  query: string,
  k: number,
  options: FindOptions = {},
): Promise<FindResult> {
  const scanned = await scanDirectory(model, dir, {
    ...(options.model ? { model: options.model } : {}),
    ...options.scan,
  });

  const docs: DocumentText[] = [];
  for (const item of scanned.items) {
    const doc = item.result.document;
    if (doc) docs.push({ id: item.file, text: extractionText(doc) });
  }

  const index = await indexDocuments(embedder, docs, options.chunk);
  const citations = await search(index, embedder, query, k);
  return { citations, scanned };
}
