/**
 * Scan a directory of documents into a report of extractions (ADR-0002,
 * ADR-0008, ADR-0009).
 *
 * Reads the image files in a directory and runs each through `extract` with the
 * injected provider, strictly one at a time. Sequential by design: only one
 * model is resident at a time on the 8 GB target (ADR-0002), so there is no
 * benefit to overlapping calls and real cost to the memory spike. The agent
 * only proposes; nothing here mutates the scanned files (ADR-0008).
 *
 * With a `classify` option, a second stage runs after all extractions: the
 * embedder loads once, embeds every valid document's extraction text, and the
 * ADR-0009 k-NN classifier votes on each type. Stages are batched by model,
 * not interleaved per document, so the VLM and the embedder are never resident
 * together. Each item then carries a `Reconciliation` verdict. Per the
 * accepted ADR-0009 amendment, a third stage re-extracts each disputed
 * document exactly once under the classifier's type-specific schema and
 * upgrades it to `corrected` when the result validates as that type; anything
 * else stays `disputed` for human review.
 *
 * Phase 1 handles image files only; PDF rendering and the OCR cross-arm land
 * later. Non-image files are reported as skipped, not errors.
 */

import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { TypeClassifier } from './classifier.js';
import { buildClassifier } from './classifier-seeds.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { type ExtractResult, extract } from './extract.js';
import { extractionText } from './extraction-text.js';
import type { ModelProvider } from './model-provider.js';
import {
  CLASSIFIER_K,
  CONFIDENCE_THRESHOLD,
  type Reconciliation,
  reconcileType,
} from './reconcile.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** One scanned document and its extraction. */
export interface ScanItem {
  /** File name relative to the scanned directory. */
  file: string;
  /** The extraction outcome (may be invalid; see `ExtractResult`). */
  result: ExtractResult;
  /** The type verdict after the classification stage (ADR-0009). */
  reconciliation: Reconciliation;
}

/** The result of scanning a directory. */
export interface ScanReport {
  /** Image files that were extracted, in sorted order. */
  scanned: string[];
  /** Non-image files that were skipped. */
  skipped: string[];
  /** One item per scanned file. */
  items: ScanItem[];
  /**
   * Why the classification stage produced no verdicts, or null when it ran
   * (or was not configured). When set, items keep single-stage VLM labels.
   */
  classifierError: string | null;
}

/** Configuration for the ADR-0009 classification stage of a scan. */
export interface ClassifyStageOptions {
  /** Embeds extraction texts (and seeds, unless a classifier is injected). */
  embedder: EmbeddingProvider;
  /**
   * Prebuilt classifier (tests, or a persisted label store later). Defaults
   * to one built from `SEED_EXAMPLES` with `embedder`.
   */
  classifier?: TypeClassifier;
  /** Neighbors per vote; defaults to `CLASSIFIER_K`. */
  k?: number;
  /** Confidence cutoff for reconciliation; defaults to `CONFIDENCE_THRESHOLD`. */
  threshold?: number;
}

/** Options for a directory scan. */
export interface ScanOptions {
  /** Model tag override passed to each extraction. */
  model?: string;
  /** Run the ADR-0009 classification stage after extraction. */
  classify?: ClassifyStageOptions;
}

/**
 * Scan `dir`, extract every image file in it, and reconcile document types.
 *
 * Failure modes: rejects if `dir` cannot be read, or if the model provider
 * rejects on a file (e.g. the runtime is unreachable). Per-file extraction
 * failures are captured as `result.valid === false`, not thrown, so one
 * unreadable document does not abort the batch's report shape. The
 * classification stage never rejects: if the embedder or classifier fails,
 * items keep their single-stage VLM labels (`status: 'unclassified'`) and
 * `classifierError` records the reason. A failed typed re-extraction (provider
 * error, invalid output, or a type other than the target) leaves the item
 * `disputed` with its original extraction and review flag intact.
 */
export async function scanDirectory(
  provider: ModelProvider,
  dir: string,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  const scanned: string[] = [];
  const skipped: string[] = [];
  for (const name of files) {
    if (IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) {
      scanned.push(name);
    } else {
      skipped.push(name);
    }
  }

  const items: ScanItem[] = [];
  for (const file of scanned) {
    const bytes = await readFile(join(dir, file));
    const result = await extract(provider, {
      images: [bytes.toString('base64')],
      ...(options.model ? { model: options.model } : {}),
    });
    items.push({
      file,
      result,
      reconciliation: reconcileType(result.document?.type ?? null, null),
    });
  }

  let classifierError: string | null = null;
  if (options.classify) {
    const { embedder, k = CLASSIFIER_K, threshold = CONFIDENCE_THRESHOLD } = options.classify;
    const classifiable = items.flatMap((item) => {
      const doc = item.result.document;
      return doc ? [{ item, doc }] : [];
    });
    if (classifiable.length > 0) {
      try {
        const classifier = options.classify.classifier ?? (await buildClassifier(embedder));
        const vectors = await embedder.embed(classifiable.map(({ doc }) => extractionText(doc)));
        classifiable.forEach(({ item, doc }, i) => {
          const vector = vectors[i];
          if (!vector) return;
          item.reconciliation = reconcileType(doc.type, classifier.classify(vector, k), threshold);
        });
      } catch (error) {
        classifierError = error instanceof Error ? error.message : String(error);
      }
    }

    // Third stage (accepted ADR-0009 amendment): one typed re-extraction per
    // disputed item, upgrading to `corrected` only when the result validates
    // as the classifier's type.
    for (const item of items) {
      if (item.reconciliation.status !== 'disputed') continue;
      const target = item.reconciliation.classification?.type;
      if (!target) continue;
      try {
        const bytes = await readFile(join(dir, item.file));
        const retry = await extract(provider, {
          images: [bytes.toString('base64')],
          type: target,
          ...(options.model ? { model: options.model } : {}),
        });
        if (retry.valid && retry.document?.type === target) {
          item.result = retry;
          item.reconciliation = {
            effectiveType: target,
            status: 'corrected',
            review: false,
            vlmType: item.reconciliation.vlmType,
            classification: item.reconciliation.classification,
          };
        }
      } catch {
        // Leave the item disputed; its review flag already routes it to a human.
      }
    }
  }

  return { scanned, skipped, items, classifierError };
}
