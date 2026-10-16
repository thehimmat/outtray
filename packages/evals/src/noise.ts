/**
 * The noise floor (METHODOLOGY.md, "Record/replay CI"): run the live eval
 * several times on one commit and report what changes between identical
 * runs, before any threshold or speed claim is trusted.
 *
 * Two things can move between runs at temperature 0: a field's verdict (the
 * model's output is not perfectly deterministic on this runtime) and the time
 * a call takes (machine load, thermal state, what else is resident). Both are
 * reported here; neither is a pass or fail.
 */

import { extract, type ModelProvider } from '@outtray/core';
import { breakdown } from './cost.js';
import { loadFixture, loadManifest } from './fixtures/load.js';
import { scoreFixture } from './run-eval.js';
import type { FieldVerdict } from './score.js';

/** One fixture's outcome in one run. */
export interface NoiseSample {
  id: string;
  /** Verdict per scored field. */
  fields: Record<string, FieldVerdict>;
  totalMs: number;
  prefillMs: number | null;
}

/** One full pass over the fixtures. */
export interface NoiseRun {
  fixtures: NoiseSample[];
}

/** What varied across runs. */
export interface NoiseFloor {
  runs: number;
  /** Fields whose verdict was not the same in every run, with how often each verdict came up. */
  unstable: Array<{ id: string; field: string; verdicts: Partial<Record<FieldVerdict, number>> }>;
  stableFields: { stable: number; total: number };
  /** Matched fields per run: the spread of the headline true-positive count. */
  truePositives: { min: number; max: number };
  /** Per fixture, wall time across runs. */
  timing: Array<{ id: string; minMs: number; medianMs: number; maxMs: number }>;
  /** Mean over fixtures of each fixture's coefficient of variation in wall time. */
  meanTimingCv: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Compare runs of the same fixtures.
 *
 * Failure modes: throws `RangeError` for fewer than two runs, since one run
 * has no spread. A fixture missing from some runs is compared over the runs
 * that have it.
 */
export function noiseFloor(runs: readonly NoiseRun[]): NoiseFloor {
  if (runs.length < 2) throw new RangeError('A noise floor needs at least two runs.');

  const byFixture = new Map<string, NoiseSample[]>();
  for (const run of runs) {
    for (const sample of run.fixtures) {
      byFixture.set(sample.id, [...(byFixture.get(sample.id) ?? []), sample]);
    }
  }

  const unstable: NoiseFloor['unstable'] = [];
  let stable = 0;
  let total = 0;
  const timing: NoiseFloor['timing'] = [];
  const cvs: number[] = [];
  for (const [id, samples] of byFixture) {
    const fields = new Set(samples.flatMap((s) => Object.keys(s.fields)));
    for (const field of fields) {
      total += 1;
      const verdicts: Partial<Record<FieldVerdict, number>> = {};
      for (const s of samples) {
        const v = s.fields[field];
        if (v) verdicts[v] = (verdicts[v] ?? 0) + 1;
      }
      if (Object.keys(verdicts).length === 1) stable += 1;
      else unstable.push({ id, field, verdicts });
    }
    const times = samples.map((s) => s.totalMs);
    timing.push({
      id,
      minMs: Math.min(...times),
      medianMs: median(times),
      maxMs: Math.max(...times),
    });
    cvs.push(coefficientOfVariation(times));
  }

  const tps = runs.map(
    (run) =>
      run.fixtures.flatMap((s) => Object.values(s.fields)).filter((v) => v === 'match').length,
  );
  return {
    runs: runs.length,
    unstable,
    stableFields: { stable, total },
    truePositives: { min: Math.min(...tps), max: Math.max(...tps) },
    timing,
    meanTimingCv: cvs.length === 0 ? 0 : cvs.reduce((a, b) => a + b, 0) / cvs.length,
  };
}

/**
 * One pass over every committed fixture: extract, score each field, and keep
 * the call's timing. Run it live, several times, for `noiseFloor`.
 *
 * Failure modes: rejects if a fixture cannot be read or the provider rejects.
 */
export async function runNoiseSample(
  provider: ModelProvider,
  options: { model: string },
): Promise<NoiseRun> {
  const manifest = await loadManifest();
  const fixtures: NoiseSample[] = [];
  for (const entry of manifest.fixtures) {
    const fixture = await loadFixture(entry);
    const result = await extract(provider, { images: [fixture.imageBase64], model: options.model });
    const scored = scoreFixture(fixture.labels, result.document);
    const cost = breakdown(fixture.id, fixture.labels.type, result.usage);
    fixtures.push({
      id: fixture.id,
      fields: Object.fromEntries(scored.fields.map((f) => [f.field, f.verdict])),
      totalMs: cost.totalMs,
      prefillMs: cost.prefillMs,
    });
  }
  return { fixtures };
}
