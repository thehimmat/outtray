import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breakdown, runCostReport, summarize } from './cost.js';
import { fixturesRoot } from './fixtures/load.js';
import { RecordingProvider } from './recording-provider.js';

const usage = (over: Partial<Parameters<typeof breakdown>[2]> = {}) => ({
  loadMs: 200,
  promptTokens: 3300,
  genTokens: 100,
  genTokPerSec: 40,
  totalMs: 30_000,
  ...over,
});

describe('breakdown', () => {
  it('splits a call into load, generating, and the rest (reading the prompt and image)', () => {
    expect(breakdown('bill-001', 'bill', usage())).toEqual({
      id: 'bill-001',
      type: 'bill',
      loadMs: 200,
      generateMs: 2500,
      prefillMs: 27_300,
      totalMs: 30_000,
      promptTokens: 3300,
      genTokens: 100,
    });
  });

  it('never reports a negative remainder when the runtime rounds', () => {
    const b = breakdown('x', 'bill', usage({ totalMs: 2600, loadMs: 200 }));
    expect(b.prefillMs).toBe(0);
  });

  it('counts generating as unknown when throughput was not reported', () => {
    const b = breakdown('x', 'bill', usage({ genTokPerSec: null }));
    expect(b.generateMs).toBeNull();
    expect(b.prefillMs).toBeNull();
  });
});

describe('summarize', () => {
  it('reports medians, the slowest call, and the share of time spent reading the input', () => {
    const rows = [
      breakdown('a', 'bill', usage({ totalMs: 20_000 })),
      breakdown('b', 'bill', usage({ totalMs: 30_000 })),
      breakdown('c', 'policy', usage({ totalMs: 40_000, loadMs: 10_000 })),
    ];
    const s = summarize(rows);
    expect(s.calls).toBe(3);
    expect(s.medianMs).toEqual({ load: 200, prefill: 27_300, generate: 2500, total: 30_000 });
    expect(s.slowest).toEqual({ id: 'c', totalMs: 40_000 });
    // (17300 + 27300 + 27500) / 90000
    expect(s.prefillShare).toBeCloseTo(72_100 / 90_000, 6);
  });
});

describe('runCostReport (replay) matches the committed cost snapshot', () => {
  it('reads the recorded timings of every fixture and reproduces the snapshot', async () => {
    const provider = new RecordingProvider({
      dir: join(fixturesRoot(), '..', 'recordings'),
      mode: 'replay',
    });
    const rows = await runCostReport(provider, { model: 'qwen3-vl:2b' });
    const snapshot = JSON.parse(await readFile(join(fixturesRoot(), 'cost.json'), 'utf8'));
    expect(rows.length).toBe(10);
    expect(summarize(rows)).toEqual(snapshot.summary);
  });
});
