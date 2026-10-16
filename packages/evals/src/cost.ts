/**
 * What one extraction costs on the dev machine, from the timings the runtime
 * reported when each recording was made (Phase 4 cost dashboard).
 *
 * Every recording keeps Ollama's own usage report for that call: model load
 * time, prompt and output token counts, generation throughput, and total wall
 * time. Replaying them costs nothing, so CI regenerates the same breakdown the
 * dev machine measured and fails if it drifts from the committed snapshot.
 *
 * The runtime reports load and generation directly; the rest of the wall time
 * is reading the prompt and the page image (prefill) plus a little overhead,
 * so prefill is taken by difference and labeled that way.
 */

import { extract, type GenerateUsage, type ModelProvider } from '@outtray/core';
import { loadFixture, loadManifest } from './fixtures/load.js';

/** One call's time, split by where it went. Milliseconds throughout. */
export interface CallCost {
  id: string;
  type: string;
  loadMs: number;
  /** Output tokens over reported throughput; null when throughput was not reported. */
  generateMs: number | null;
  /** Wall time left after load and generating: the prompt and image, by difference. */
  prefillMs: number | null;
  totalMs: number;
  promptTokens: number | null;
  genTokens: number | null;
}

/**
 * Split one call's reported usage.
 *
 * Failure modes: none; pure. A remainder below zero (runtime rounding) is
 * reported as 0; without a throughput figure, generating and prefill are null.
 */
export function breakdown(id: string, type: string, usage: GenerateUsage): CallCost {
  const generateMs =
    usage.genTokPerSec && usage.genTokens !== undefined
      ? Math.round((usage.genTokens / usage.genTokPerSec) * 1000)
      : null;
  const prefillMs =
    generateMs === null ? null : Math.max(0, usage.totalMs - usage.loadMs - generateMs);
  return {
    id,
    type,
    loadMs: usage.loadMs,
    generateMs,
    prefillMs,
    totalMs: usage.totalMs,
    promptTokens: usage.promptTokens ?? null,
    genTokens: usage.genTokens ?? null,
  };
}

/** The dashboard's headline numbers. */
export interface CostSummary {
  calls: number;
  medianMs: { load: number; prefill: number; generate: number; total: number };
  slowest: { id: string; totalMs: number };
  /** Share of all wall time spent on prefill, 0 to 1. */
  prefillShare: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * Medians per phase, the slowest call, and the prefill share of all time.
 *
 * Failure modes: throws `RangeError` for no calls, since every figure would
 * be undefined. Calls without a throughput figure count as zero prefill and
 * generating time.
 */
export function summarize(rows: readonly CallCost[]): CostSummary {
  if (rows.length === 0) throw new RangeError('No calls to summarize.');
  const total = rows.reduce((sum, r) => sum + r.totalMs, 0);
  const prefill = rows.reduce((sum, r) => sum + (r.prefillMs ?? 0), 0);
  const slowest = rows.reduce((a, b) => (b.totalMs > a.totalMs ? b : a));
  return {
    calls: rows.length,
    medianMs: {
      load: median(rows.map((r) => r.loadMs)),
      prefill: median(rows.map((r) => r.prefillMs ?? 0)),
      generate: median(rows.map((r) => r.generateMs ?? 0)),
      total: median(rows.map((r) => r.totalMs)),
    },
    slowest: { id: slowest.id, totalMs: slowest.totalMs },
    prefillShare: prefill / total,
  };
}

/**
 * Extract every committed fixture through `provider` and break down each
 * call's reported time. With a replaying provider this reads the dev
 * machine's measurements and runs no model.
 *
 * Failure modes: rejects if a fixture cannot be read or (in replay) a
 * recording is missing (`StaleRecordingError`).
 */
export async function runCostReport(
  provider: ModelProvider,
  options: { model: string },
): Promise<CallCost[]> {
  const manifest = await loadManifest();
  const rows: CallCost[] = [];
  for (const entry of manifest.fixtures) {
    const fixture = await loadFixture(entry);
    const result = await extract(provider, { images: [fixture.imageBase64], model: options.model });
    rows.push(breakdown(fixture.id, fixture.labels.type, result.usage));
  }
  return rows;
}
