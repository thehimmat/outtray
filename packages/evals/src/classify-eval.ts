/**
 * Classification eval: does the ADR-0009 classifier improve on the VLM's
 * document-type labels, and does the reconciled pipeline close the gap
 * end to end? (METHODOLOGY.md, issue #37.)
 *
 * For each fixture it replays the VLM extraction, turns it into text, runs the
 * seed classifier over that text, then routes the pair through the same
 * `reconcileType`/`applyCorrection` the scan pipeline uses, including the one
 * typed re-extraction on a confident disagreement. Three labels are compared
 * against ground truth: the VLM's, the classifier's, and the reconciled
 * effective type. The model provider is injected (replay or record-missing on
 * dev, replay in CI once #52 lands); the embedder is injected too.
 */

import {
  applyCorrection,
  buildClassifier,
  CLASSIFIER_K,
  classifyText,
  type EmbeddingProvider,
  extract,
  extractionText,
  type ModelProvider,
  reconcileType,
} from '@outtray/core';
import { loadFixture, loadManifest } from './fixtures/load.js';

/** One fixture's classification outcome. */
export interface ClassifyRow {
  id: string;
  label: string;
  vlm: string;
  classifier: string;
  confidence: number | null;
  /** The pipeline's effective type after reconciliation and any correction. */
  reconciled: string;
  /** The reconciliation status the pipeline would report. */
  status: string;
}

/** Correct-count out of total for a labeller. */
export interface Accuracy {
  k: number;
  n: number;
}

/** Classification accuracy for all three labellers, overall and per type. */
export interface ClassifyReport {
  rows: ClassifyRow[];
  vlm: Accuracy;
  classifier: Accuracy;
  reconciled: Accuracy;
  perType: Array<{ type: string; vlm: Accuracy; classifier: Accuracy; reconciled: Accuracy }>;
}

/**
 * Run the classification eval over every fixture.
 *
 * Failure modes: rejects if a fixture cannot be read, the model rejects (or, in
 * replay, a recording is missing), or the embedder rejects. `model` is the
 * extraction model tag, passed through for stable recording keys.
 */
export async function classifyEval(
  model: ModelProvider,
  embedder: EmbeddingProvider,
  options: { model: string },
): Promise<ClassifyReport> {
  const classifier = await buildClassifier(embedder);
  const manifest = await loadManifest();

  const rows: ClassifyRow[] = [];
  for (const entry of manifest.fixtures) {
    const fixture = await loadFixture(entry);
    const result = await extract(model, { images: [fixture.imageBase64], model: options.model });
    const doc = result.document;
    const vlm = doc ? doc.type : 'invalid';
    const text = doc ? extractionText(doc) : '';
    const classification = text
      ? await classifyText(classifier, embedder, text, CLASSIFIER_K)
      : null;

    let reconciliation = reconcileType(doc ? doc.type : null, classification);
    if (reconciliation.status === 'disputed' && reconciliation.classification) {
      const retry = await extract(model, {
        images: [fixture.imageBase64],
        model: options.model,
        type: reconciliation.classification.type,
      });
      reconciliation = applyCorrection(reconciliation, retry);
    }

    rows.push({
      id: fixture.id,
      label: fixture.labels.type,
      vlm,
      classifier: classification ? classification.type : 'none',
      confidence: classification ? classification.confidence : null,
      reconciled: reconciliation.effectiveType,
      status: reconciliation.status,
    });
  }

  return tallyClassification(rows);
}

/** Reduce classification rows to per-type and overall accuracy for all labellers. Pure. */
export function tallyClassification(rows: ClassifyRow[]): ClassifyReport {
  const blank = () => ({
    vlm: { k: 0, n: 0 },
    classifier: { k: 0, n: 0 },
    reconciled: { k: 0, n: 0 },
  });
  const byType = new Map<string, ReturnType<typeof blank>>();
  const overall = blank();
  for (const row of rows) {
    const acc = byType.get(row.label) ?? blank();
    for (const [labeller, value] of [
      ['vlm', row.vlm],
      ['classifier', row.classifier],
      ['reconciled', row.reconciled],
    ] as const) {
      acc[labeller].n += 1;
      overall[labeller].n += 1;
      if (value === row.label) {
        acc[labeller].k += 1;
        overall[labeller].k += 1;
      }
    }
    byType.set(row.label, acc);
  }

  const perType = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, acc]) => ({ type, ...acc }));

  return { rows, ...overall, perType };
}
