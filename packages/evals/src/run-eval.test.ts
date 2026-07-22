import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixturesRoot } from './fixtures/load.js';
import { RecordingProvider } from './recording-provider.js';
import { runEval, scoreFixture } from './run-eval.js';

const MODEL = 'qwen3-vl:2b';

describe('scoreFixture', () => {
  const labels = {
    type: 'bill' as const,
    payee: 'State DMV',
    amount_due: '$301.00',
    due_date: '2026-08-31',
    late_fee: '$54.00',
  };

  it('scores a perfect extraction as all matches', () => {
    const doc = {
      type: 'bill' as const,
      summary: '',
      action_items: [],
      payee: 'STATE DMV',
      amount_due: '301',
      due_date: '2026-08-31',
      late_fee: '$54',
    };
    const scored = scoreFixture(labels, doc);
    expect(scored.fields.every((f) => f.verdict === 'match')).toBe(true);
    expect(scored.valid).toBe(true);
  });

  it('scores a misclassification as a type miss plus recall loss on the rest', () => {
    const doc = {
      type: 'statement' as const,
      summary: '',
      action_items: [],
      institution: 'x',
      account_number: 'y',
      period_start: null,
      period_end: null,
      balance: null,
    };
    const scored = scoreFixture(labels, doc);
    expect(scored.classifiedAs).toBe('statement');
    // type mismatched; bill-only fields all missed
    expect(scored.fields.find((f) => f.field === 'type')?.verdict).toBe('mismatch');
    expect(
      scored.fields.filter((f) => f.field !== 'type').every((f) => f.verdict === 'missed'),
    ).toBe(true);
  });

  it('scores a null (invalid) extraction as all missed', () => {
    const scored = scoreFixture(labels, null);
    expect(scored.valid).toBe(false);
    expect(scored.fields.every((f) => f.verdict === 'missed')).toBe(true);
  });
});

describe('runEval (replay) matches the committed scoreboard', () => {
  it('replays every recording and reproduces the scoreboard counts', async () => {
    const provider = new RecordingProvider({
      dir: join(fixturesRoot(), '..', 'recordings'),
      mode: 'replay',
    });
    // Throws StaleRecordingError if any recording is missing (prompt/schema/fixtures drifted).
    const report = await runEval(provider, { model: MODEL });

    const snapshot = JSON.parse(
      await readFile(join(fixturesRoot(), 'scoreboard.json'), 'utf8'),
    ) as {
      overall: typeof report.overall.counts;
      perType: Array<{ type: string; counts: typeof report.overall.counts }>;
    };

    expect(report.overall.counts).toEqual(snapshot.overall);
    for (const t of report.perType) {
      const row = snapshot.perType.find((s) => s.type === t.type);
      expect(row?.counts, `counts for ${t.type}`).toEqual(t.counts);
    }
  });
});
