import { describe, expect, it } from 'vitest';
import { compareField, precisionRecall, tally, wilson } from './score.js';

describe('compareField', () => {
  it('matches on normalized equality (tp)', () => {
    expect(compareField('August 31, 2026', '2026-08-31', 'date')).toBe('match');
    expect(compareField('$301.00', '301', 'amount')).toBe('match');
    expect(compareField('State DMV', 'state  dmv', 'text')).toBe('match');
  });
  it('flags a wrong value as mismatch (both fp and fn)', () => {
    expect(compareField('2026-08-31', '2026-09-01', 'date')).toBe('mismatch');
  });
  it('flags a missed expected value (fn)', () => {
    expect(compareField('State DMV', null, 'text')).toBe('missed');
    expect(compareField('2026-08-31', '', 'date')).toBe('missed');
  });
  it('flags a spurious value where none was expected (fp)', () => {
    expect(compareField(null, 'State DMV', 'text')).toBe('spurious');
  });
  it('counts both-absent as a correct rejection (tn)', () => {
    expect(compareField(null, null, 'text')).toBe('both-absent');
    expect(compareField(null, '', 'date')).toBe('both-absent');
  });
});

describe('tally + precisionRecall', () => {
  it('turns verdicts into tp/fp/fn/tn counts', () => {
    const counts = tally(['match', 'match', 'mismatch', 'missed', 'spurious', 'both-absent']);
    // match x2 -> tp2; mismatch -> fp1+fn1; missed -> fn1; spurious -> fp1; both-absent -> tn1
    expect(counts).toEqual({ tp: 2, fp: 2, fn: 2, tn: 1 });
  });
  it('computes precision and recall as raw counts', () => {
    const pr = precisionRecall({ tp: 2, fp: 2, fn: 2, tn: 1 });
    expect(pr.precision).toEqual({ k: 2, n: 4, rate: 0.5 });
    expect(pr.recall).toEqual({ k: 2, n: 4, rate: 0.5 });
  });
  it('guards division when there are no positives', () => {
    const pr = precisionRecall({ tp: 0, fp: 0, fn: 0, tn: 3 });
    expect(pr.precision.n).toBe(0);
    expect(pr.precision.rate).toBeNull();
  });
});

describe('wilson', () => {
  it('brackets the point estimate', () => {
    const ci = wilson(9, 10);
    expect(ci.low).toBeLessThan(0.9);
    expect(ci.high).toBeGreaterThan(0.9);
    expect(ci.low).toBeGreaterThan(0.5);
    expect(ci.high).toBeLessThanOrEqual(1);
  });
  it('is wide at small n', () => {
    const small = wilson(1, 1);
    expect(small.low).toBeLessThan(0.6); // 1/1 but the interval is not [1,1]
  });
  it('returns null bounds for n=0', () => {
    expect(wilson(0, 0).low).toBeNull();
  });
});
