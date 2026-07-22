/**
 * Per-field extraction scoring (METHODOLOGY.md).
 *
 * Fields are compared on normalized values and reduced to precision/recall as
 * raw counts (e.g. 11/12), never bare percentages at small N, with Wilson score
 * intervals for the proportion. A wrong value counts against both precision and
 * recall (it is a false positive and a false negative), matching standard
 * slot-filling scoring.
 */

import { type FieldKind, normalizeValue } from './normalize.js';

/** The comparison outcome for one field. */
export type FieldVerdict =
  | 'match' // both present and equal -> tp
  | 'mismatch' // both present, not equal -> fp + fn
  | 'missed' // expected present, actual absent -> fn
  | 'spurious' // expected absent, actual present -> fp
  | 'both-absent'; // neither present -> tn

/** Confusion-matrix counts. */
export interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

function absent(normalized: string | null): boolean {
  return normalized === null || normalized === '';
}

/**
 * Compare one expected value against one extracted value under a field kind.
 *
 * Failure modes: none; pure. `null`, `undefined`, and empty strings are all
 * treated as "absent" after normalization.
 */
export function compareField(
  expected: string | null | undefined,
  actual: string | null | undefined,
  kind: FieldKind,
): FieldVerdict {
  const e = normalizeValue(kind, expected);
  const a = normalizeValue(kind, actual);
  const eAbsent = absent(e);
  const aAbsent = absent(a);

  if (eAbsent && aAbsent) return 'both-absent';
  if (eAbsent) return 'spurious';
  if (aAbsent) return 'missed';
  return e === a ? 'match' : 'mismatch';
}

/** Reduce a list of verdicts to confusion-matrix counts. */
export function tally(verdicts: readonly FieldVerdict[]): Counts {
  const counts: Counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const v of verdicts) {
    switch (v) {
      case 'match':
        counts.tp += 1;
        break;
      case 'mismatch':
        counts.fp += 1;
        counts.fn += 1;
        break;
      case 'missed':
        counts.fn += 1;
        break;
      case 'spurious':
        counts.fp += 1;
        break;
      case 'both-absent':
        counts.tn += 1;
        break;
    }
  }
  return counts;
}

/** A proportion reported as a raw fraction, with the rate null when undefined (n=0). */
export interface Proportion {
  k: number;
  n: number;
  rate: number | null;
}

function proportion(k: number, n: number): Proportion {
  return { k, n, rate: n === 0 ? null : k / n };
}

/** Precision (tp / tp+fp) and recall (tp / tp+fn) as raw counts. */
export function precisionRecall(counts: Counts): {
  precision: Proportion;
  recall: Proportion;
} {
  return {
    precision: proportion(counts.tp, counts.tp + counts.fp),
    recall: proportion(counts.tp, counts.tp + counts.fn),
  };
}

/** A confidence interval for a proportion; bounds are null when undefined (n=0). */
export interface Interval {
  point: number | null;
  low: number | null;
  high: number | null;
}

/**
 * Wilson score interval for a binomial proportion k/n.
 *
 * Preferred over the normal approximation at the small N this project runs at:
 * it stays within [0, 1] and is not degenerate at k = 0 or k = n. `z` defaults
 * to 1.96 (95%). Returns null bounds for n = 0.
 */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { point: null, low: null, high: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    point: p,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}
