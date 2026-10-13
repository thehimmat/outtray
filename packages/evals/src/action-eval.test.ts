import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionItem } from '@outtray/core';
import { describe, expect, it } from 'vitest';
import { type ExpectedAction, runActionEval, scoreActions } from './action-eval.js';
import { fixturesRoot } from './fixtures/load.js';
import { RecordingProvider } from './recording-provider.js';

const MODEL = 'qwen3-vl:2b';

function planned(overrides: Partial<ActionItem>): ActionItem {
  return {
    id: 'x',
    kind: 'todo',
    ruleId: 'todo-extracted',
    title: 'Pay Metro Electric',
    date: '2027-02-16',
    advice: null,
    needsReviewFirst: false,
    citations: [],
    status: 'proposed',
    ...overrides,
  };
}

const PAY: ExpectedAction = {
  kind: 'todo',
  ruleId: 'todo-extracted',
  date: '2027-02-16',
  titleIncludes: ['pay'],
};
const SHRED: ExpectedAction = {
  kind: 'retention_advice',
  ruleId: 'ret-bill',
  date: null,
  advice: 'shred',
};

describe('scoreActions', () => {
  it('counts a planned item matching an expected one as a true positive', () => {
    const s = scoreActions([planned({})], [PAY]);
    expect(s.counts).toEqual({ tp: 1, fp: 0, fn: 0, tn: 0 });
    expect(s.perKind.todo).toEqual({ tp: 1, fp: 0, fn: 0, tn: 0 });
  });

  it('matches titles case-insensitively on every required word', () => {
    expect(scoreActions([planned({ title: 'PAY the bill' })], [PAY]).counts.tp).toBe(1);
    expect(scoreActions([planned({ title: 'Settle the bill' })], [PAY]).counts).toEqual({
      tp: 0,
      fp: 1,
      fn: 1,
      tn: 0,
    });
  });

  it('requires the same kind, rule, date and advice', () => {
    expect(scoreActions([planned({ date: '2027-02-17' })], [PAY]).counts.tp).toBe(0);
    expect(scoreActions([planned({ kind: 'attention_flag' })], [PAY]).counts.tp).toBe(0);
    expect(
      scoreActions(
        [planned({ kind: 'retention_advice', ruleId: 'ret-bill', date: null, advice: 'keep' })],
        [SHRED],
      ).counts.tp,
    ).toBe(0);
  });

  it('matches one to one: a duplicate planned item is a false positive', () => {
    const s = scoreActions([planned({}), planned({ id: 'y' })], [PAY]);
    expect(s.counts).toEqual({ tp: 1, fp: 1, fn: 0, tn: 0 });
  });

  it('attributes misses and extras to their kinds', () => {
    const s = scoreActions(
      [planned({ kind: 'retention_advice', ruleId: 'ret-statement', date: null, advice: 'keep' })],
      [PAY, SHRED],
    );
    expect(s.perKind.todo).toEqual({ tp: 0, fp: 0, fn: 1, tn: 0 });
    expect(s.perKind.retention_advice).toEqual({ tp: 0, fp: 1, fn: 1, tn: 0 });
  });
});

describe('runActionEval (replay) matches the committed action scoreboard', () => {
  it('plans from every recording and reproduces the action counts', async () => {
    const provider = new RecordingProvider({
      dir: join(fixturesRoot(), '..', 'recordings'),
      mode: 'replay',
    });
    const report = await runActionEval(provider, { model: MODEL });
    const snapshot = JSON.parse(
      await readFile(join(fixturesRoot(), 'action-scoreboard.json'), 'utf8'),
    ) as { asOf: string; overall: unknown; perKind: Record<string, unknown> };

    expect(report.asOf).toBe(snapshot.asOf);
    expect(report.overall.counts).toEqual(snapshot.overall);
    for (const row of report.perKind) {
      expect(snapshot.perKind[row.kind], `counts for ${row.kind}`).toEqual(row.counts);
    }
  });
});
