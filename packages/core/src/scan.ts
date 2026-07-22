/**
 * Scan a directory of documents into a report of extractions (ADR-0002,
 * ADR-0008).
 *
 * Reads the image files in a directory and runs each through `extract` with the
 * injected provider, strictly one at a time. Sequential by design: only one
 * model is resident at a time on the 8 GB target (ADR-0002), so there is no
 * benefit to overlapping calls and real cost to the memory spike. The agent
 * only proposes; nothing here mutates the scanned files (ADR-0008).
 *
 * Phase 1 handles image files only; PDF rendering and the OCR cross-arm land
 * later. Non-image files are reported as skipped, not errors.
 */

import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { type ExtractResult, extract } from './extract.js';
import type { ModelProvider } from './model-provider.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** One scanned document and its extraction. */
export interface ScanItem {
  /** File name relative to the scanned directory. */
  file: string;
  /** The extraction outcome (may be invalid; see `ExtractResult`). */
  result: ExtractResult;
}

/** The result of scanning a directory. */
export interface ScanReport {
  /** Image files that were extracted, in sorted order. */
  scanned: string[];
  /** Non-image files that were skipped. */
  skipped: string[];
  /** One item per scanned file. */
  items: ScanItem[];
}

/** Options for a directory scan. */
export interface ScanOptions {
  /** Model tag override passed to each extraction. */
  model?: string;
}

/**
 * Scan `dir` and extract every image file in it.
 *
 * Failure modes: rejects if `dir` cannot be read, or if the provider rejects on
 * a file (e.g. the runtime is unreachable). Per-file extraction failures are
 * captured as `result.valid === false`, not thrown, so one unreadable document
 * does not abort the batch's report shape.
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
    items.push({ file, result });
  }

  return { scanned, skipped, items };
}
