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
 *
 * A fourth label is the classifier's vote on the page's OCR text (ADR-0009
 * amendment 3, #159), taken the way `scanSource` takes it: readability gate,
 * then one batched embedding of `ocrPlainText`. A vote at or above the
 * threshold is routed to the typed prompt, so a wrong routed vote costs that
 * document its fields; `tallyOcrVotes` counts those.
 */

import {
  applyCorrection,
  assessReadability,
  buildClassifier,
  CLASSIFIER_K,
  CONFIDENCE_THRESHOLD,
  classifyText,
  derivedText,
  type EmbeddingProvider,
  extract,
  type ModelProvider,
  ocrPlainText,
  reconcileType,
  type TypeClassifier,
} from '@outtray/core';
import { loadFixture, loadManifest } from './fixtures/load.js';
import type { OcrLevel, OcrPage, PageRecognizer } from './ocr-eval.js';

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
  /** The OCR-text vote (`unreadable` when the gate rejected the page); absent when not measured. */
  ocr?: string;
}

/** Correct-count out of total for a labeller. */
export interface Accuracy {
  k: number;
  n: number;
}

/** Classification accuracy for every labeller, overall and per type. */
export interface ClassifyReport {
  rows: ClassifyRow[];
  vlm: Accuracy;
  classifier: Accuracy;
  reconciled: Accuracy;
  /** The OCR-text vote; `n` is 0 when no row carries one. */
  ocr: Accuracy;
  perType: Array<{
    type: string;
    vlm: Accuracy;
    classifier: Accuracy;
    reconciled: Accuracy;
    ocr: Accuracy;
  }>;
}

/** One page's OCR-text vote. */
export interface OcrVoteRow {
  id: string;
  label: string;
  level: OcrLevel;
  /** The readability gate's verdict; an unreadable page gets no vote. */
  readable: boolean;
  /** The voted type, or `unreadable`. */
  vote: string;
  confidence: number | null;
  /** True when scan would route this page to the typed prompt on the vote alone. */
  routed: boolean;
}

/** What the OCR votes would do as a routing signal. */
export interface OcrVoteTally {
  accuracy: Accuracy;
  /** Pages whose vote is at or above the threshold. */
  routed: number;
  /** Ids of routed pages whose vote is wrong: each would lose its fields. */
  routedWrong: string[];
  unreadable: number;
}

/**
 * The classifier's vote on each page's OCR text, gated and batched as
 * `scanSource` does it.
 *
 * Failure modes: rejects when `recognize` rejects (in replay, a missing or
 * stale recording) or the embedder rejects. A page the readability gate
 * rejects gets vote `unreadable` and is never routed.
 */
export async function ocrVotes(
  pages: OcrPage[],
  recognize: PageRecognizer,
  embedder: EmbeddingProvider,
  classifier: TypeClassifier,
  options: { k?: number; threshold?: number } = {},
): Promise<OcrVoteRow[]> {
  const k = options.k ?? CLASSIFIER_K;
  const threshold = options.threshold ?? CONFIDENCE_THRESHOLD;
  const read: Array<{ page: OcrPage; text: string | null }> = [];
  for (const page of pages) {
    const result = await recognize(page, page.imagePath);
    read.push({
      page,
      text: assessReadability(result).readable ? ocrPlainText(result) : null,
    });
  }
  const texts = read.flatMap((r) => (r.text === null ? [] : [r.text]));
  const vectors = texts.length > 0 ? await embedder.embed(texts) : [];
  let next = 0;
  return read.map(({ page, text }) => {
    const base = { id: page.id, label: page.source.type, level: page.level };
    if (text === null) {
      return { ...base, readable: false, vote: 'unreadable', confidence: null, routed: false };
    }
    const vector = vectors[next++];
    const vote = vector ? classifier.classify(vector, k) : null;
    return {
      ...base,
      readable: true,
      vote: vote ? vote.type : 'none',
      confidence: vote ? vote.confidence : null,
      routed: vote !== null && vote.confidence >= threshold,
    };
  });
}

/** Reduce OCR vote rows to accuracy and the routing numbers. Pure. */
export function tallyOcrVotes(rows: OcrVoteRow[]): OcrVoteTally {
  return {
    accuracy: { k: rows.filter((r) => r.vote === r.label).length, n: rows.length },
    routed: rows.filter((r) => r.routed).length,
    routedWrong: rows.filter((r) => r.routed && r.vote !== r.label).map((r) => r.id),
    unreadable: rows.filter((r) => !r.readable).length,
  };
}

/**
 * Run the classification eval over every fixture.
 *
 * Failure modes: rejects if a fixture cannot be read, the model rejects (or, in
 * replay, a recording is missing), or the embedder rejects. `model` is the
 * extraction model tag, passed through for stable recording keys. `ocr`, when
 * given, holds each fixture's OCR-text vote by id (from `ocrVotes`) for the
 * fourth column; a fixture missing from it has no OCR column entry.
 */
export async function classifyEval(
  model: ModelProvider,
  embedder: EmbeddingProvider,
  options: { model: string; ocr?: ReadonlyMap<string, string> },
): Promise<ClassifyReport> {
  const classifier = await buildClassifier(embedder);
  const manifest = await loadManifest();

  const rows: ClassifyRow[] = [];
  for (const entry of manifest.fixtures) {
    const ocr = options.ocr?.get(entry.id);
    const fixture = await loadFixture(entry);
    const result = await extract(model, { images: [fixture.imageBase64], model: options.model });
    const doc = result.document;
    const vlm = doc ? doc.type : 'invalid';
    const text = doc ? derivedText(doc) : '';
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
      ...(ocr === undefined ? {} : { ocr }),
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
    ocr: { k: 0, n: 0 },
  });
  const byType = new Map<string, ReturnType<typeof blank>>();
  const overall = blank();
  for (const row of rows) {
    const acc = byType.get(row.label) ?? blank();
    for (const [labeller, value] of [
      ['vlm', row.vlm],
      ['classifier', row.classifier],
      ['reconciled', row.reconciled],
      ['ocr', row.ocr],
    ] as const) {
      if (value === undefined) continue;
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
