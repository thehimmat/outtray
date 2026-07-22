/**
 * The eval harness: score the extraction pipeline over the fixture set
 * (METHODOLOGY.md).
 *
 * `runEval` drives each fixture through the same `extract` the product uses,
 * with a provider injected by the caller: a `RecordingProvider` in replay mode
 * for CI (no model), record mode on the dev machine, or a live `OllamaProvider`
 * for `eval:live`. Results are scored per field against the fixture labels and
 * aggregated to per-type and overall precision/recall with Wilson intervals.
 */

import { type DocumentExtraction, extract, type ModelProvider } from '@outtray/core';
import { SCORED_FIELDS } from './field-kinds.js';
import type { FixtureLabels } from './fixtures/generate.js';
import { loadFixture, loadManifest } from './fixtures/load.js';
import {
  type Counts,
  compareField,
  type FieldVerdict,
  precisionRecall,
  tally,
  wilson,
} from './score.js';

/** One field's comparison, with raw values retained for triage. */
export interface FieldScore {
  field: string;
  verdict: FieldVerdict;
  expected: string | null;
  actual: string | null;
}

/** One fixture's scored result. */
export interface FixtureScore {
  id: string;
  type: string;
  valid: boolean;
  classifiedAs: string | null;
  fields: FieldScore[];
}

/** Aggregated scores for a group of fixtures. */
export interface Aggregate {
  counts: Counts;
  precision: ReturnType<typeof precisionRecall>['precision'];
  recall: ReturnType<typeof precisionRecall>['recall'];
  recallInterval: ReturnType<typeof wilson>;
  precisionInterval: ReturnType<typeof wilson>;
}

/** The full eval report. */
export interface EvalReport {
  model: string;
  fixtureCount: number;
  overall: Aggregate;
  perType: Array<{ type: string } & Aggregate>;
  perFixture: FixtureScore[];
}

function readField(doc: DocumentExtraction | null, field: string): string | null {
  if (!doc) return null;
  const raw = (doc as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw : null;
}

/** Compare one extracted document against its labels, field by field. */
export function scoreFixture(labels: FixtureLabels, doc: DocumentExtraction | null): FixtureScore {
  const kinds = SCORED_FIELDS[labels.type];
  const fields: FieldScore[] = [];
  for (const [field, kind] of Object.entries(kinds)) {
    const expected = labels[field] ?? null;
    const actual = readField(doc, field);
    fields.push({ field, verdict: compareField(expected, actual, kind), expected, actual });
  }
  return {
    id: '',
    type: labels.type,
    valid: doc !== null,
    classifiedAs: doc ? doc.type : null,
    fields,
  };
}

function aggregate(verdicts: FieldVerdict[]): Aggregate {
  const counts = tally(verdicts);
  const pr = precisionRecall(counts);
  return {
    counts,
    precision: pr.precision,
    recall: pr.recall,
    recallInterval: wilson(counts.tp, counts.tp + counts.fn),
    precisionInterval: wilson(counts.tp, counts.tp + counts.fp),
  };
}

/**
 * Run the eval over every committed fixture.
 *
 * Failure modes: rejects if a fixture cannot be read, or (in replay) if a
 * recording is missing (`StaleRecordingError`) so CI fails loudly rather than
 * scoring a partial set. `model` is passed through explicitly so recording keys
 * are stable.
 */
export async function runEval(
  provider: ModelProvider,
  options: { model: string },
): Promise<EvalReport> {
  const manifest = await loadManifest();
  const perFixture: FixtureScore[] = [];

  for (const entry of manifest.fixtures) {
    const fixture = await loadFixture(entry);
    const result = await extract(provider, { images: [fixture.imageBase64], model: options.model });
    const scored = scoreFixture(fixture.labels, result.document);
    scored.id = fixture.id;
    perFixture.push(scored);
  }

  const byType = new Map<string, FieldVerdict[]>();
  const all: FieldVerdict[] = [];
  for (const fx of perFixture) {
    const list = byType.get(fx.type) ?? [];
    for (const f of fx.fields) {
      list.push(f.verdict);
      all.push(f.verdict);
    }
    byType.set(fx.type, list);
  }

  const perType = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, verdicts]) => ({ type, ...aggregate(verdicts) }));

  return {
    model: options.model,
    fixtureCount: perFixture.length,
    overall: aggregate(all),
    perType,
    perFixture,
  };
}
