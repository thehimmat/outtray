import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixturesRoot } from './fixtures/load.js';
import { type NoiseRun, noiseFloor, runNoiseSample } from './noise.js';
import { RecordingProvider } from './recording-provider.js';
import type { FieldVerdict } from './score.js';

function run(fixtures: Array<[string, Record<string, FieldVerdict>, number]>): NoiseRun {
  return {
    fixtures: fixtures.map(([id, fields, totalMs]) => ({
      id,
      fields,
      totalMs,
      prefillMs: totalMs - 2000,
    })),
  };
}

describe('noiseFloor', () => {
  it('finds the fields whose verdict changes between identical runs', () => {
    const floor = noiseFloor([
      run([['bill-001', { payee: 'match', amount_due: 'match' }, 30_000]]),
      run([['bill-001', { payee: 'match', amount_due: 'missed' }, 31_000]]),
      run([['bill-001', { payee: 'match', amount_due: 'match' }, 29_000]]),
    ]);
    expect(floor.runs).toBe(3);
    expect(floor.unstable).toEqual([
      { id: 'bill-001', field: 'amount_due', verdicts: { match: 2, missed: 1 } },
    ]);
    expect(floor.stableFields).toEqual({ stable: 1, total: 2 });
  });

  it('reports the spread of true positives across runs', () => {
    const floor = noiseFloor([
      run([['a', { x: 'match', y: 'match' }, 10_000]]),
      run([['a', { x: 'match', y: 'mismatch' }, 10_000]]),
    ]);
    expect(floor.truePositives).toEqual({ min: 1, max: 2 });
  });

  it('reports per-fixture timing spread and the overall coefficient of variation', () => {
    const floor = noiseFloor([
      run([
        ['a', {}, 20_000],
        ['b', {}, 40_000],
      ]),
      run([
        ['a', {}, 30_000],
        ['b', {}, 40_000],
      ]),
    ]);
    expect(floor.timing).toEqual([
      { id: 'a', minMs: 20_000, medianMs: 25_000, maxMs: 30_000 },
      { id: 'b', minMs: 40_000, medianMs: 40_000, maxMs: 40_000 },
    ]);
    // a: mean 25000, sd 5000 (population) -> 0.2; b: 0. Mean of per-fixture CVs.
    expect(floor.meanTimingCv).toBeCloseTo(0.1, 6);
  });

  it('refuses fewer than two runs, since one run has no spread', () => {
    expect(() => noiseFloor([run([])])).toThrow(RangeError);
  });

  it('finds no noise in replayed runs, which are the same recording twice', async () => {
    const provider = new RecordingProvider({
      dir: join(fixturesRoot(), '..', 'recordings'),
      mode: 'replay',
    });
    const runs = [
      await runNoiseSample(provider, { model: 'qwen3-vl:2b' }),
      await runNoiseSample(provider, { model: 'qwen3-vl:2b' }),
    ];
    const floor = noiseFloor(runs);
    expect(floor.unstable).toEqual([]);
    expect(floor.meanTimingCv).toBe(0);
    expect(floor.timing).toHaveLength(10);
  });
});
