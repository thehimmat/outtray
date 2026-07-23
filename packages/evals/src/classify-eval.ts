/**
 * Classification eval: does the ADR-0009 classifier improve on the VLM's
 * document-type labels? (METHODOLOGY.md, issue #37.)
 *
 * For each fixture it replays the VLM extraction, turns it into text, and runs
 * the seed classifier over that text, then compares both the VLM's type and the
 * classifier's type against the ground-truth label. The model provider is
 * injected (replay in CI, live on dev); the embedder is injected too. This
 * measures whether the cheap on-device classifier corrects the VLM's
 * bill/statement confusion.
 */

import {
  buildClassifier,
  classifyText,
  type EmbeddingProvider,
  extract,
  extractionText,
  type ModelProvider,
} from '@outtray/core';
import { loadFixture, loadManifest } from './fixtures/load.js';

/** One fixture's classification outcome. */
export interface ClassifyRow {
  id: string;
  label: string;
  vlm: string;
  classifier: string;
  confidence: number | null;
}

/** Correct-count out of total for a labeller. */
export interface Accuracy {
  k: number;
  n: number;
}

/** Classification accuracy for the VLM and the classifier, overall and per type. */
export interface ClassifyReport {
  rows: ClassifyRow[];
  vlm: Accuracy;
  classifier: Accuracy;
  perType: Array<{ type: string; vlm: Accuracy; classifier: Accuracy }>;
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
    const classification = text ? await classifyText(classifier, embedder, text, 5) : null;
    rows.push({
      id: fixture.id,
      label: fixture.labels.type,
      vlm,
      classifier: classification ? classification.type : 'none',
      confidence: classification ? classification.confidence : null,
    });
  }

  return tallyClassification(rows);
}

/** Reduce classification rows to per-type and overall accuracy for both labellers. Pure. */
export function tallyClassification(rows: ClassifyRow[]): ClassifyReport {
  const byType = new Map<string, { vlm: Accuracy; classifier: Accuracy }>();
  const overall = { vlm: { k: 0, n: 0 }, classifier: { k: 0, n: 0 } };
  for (const row of rows) {
    const acc = byType.get(row.label) ?? { vlm: { k: 0, n: 0 }, classifier: { k: 0, n: 0 } };
    acc.vlm.n += 1;
    acc.classifier.n += 1;
    overall.vlm.n += 1;
    overall.classifier.n += 1;
    if (row.vlm === row.label) {
      acc.vlm.k += 1;
      overall.vlm.k += 1;
    }
    if (row.classifier === row.label) {
      acc.classifier.k += 1;
      overall.classifier.k += 1;
    }
    byType.set(row.label, acc);
  }

  const perType = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, acc]) => ({ type, vlm: acc.vlm, classifier: acc.classifier }));

  return { rows, vlm: overall.vlm, classifier: overall.classifier, perType };
}
