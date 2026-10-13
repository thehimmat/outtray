/**
 * Field normalization for scoring (METHODOLOGY.md).
 *
 * Extraction is scored on normalized values so that trivially-different
 * renderings of the same fact ("August 31, 2026" vs "2026-08-31", "$301.00" vs
 * "301") count as matches. The eval output logs both raw and normalized values
 * so a score drop triages to scorer-vs-model quickly. Normalization is part of
 * the extraction contract, not scorer leniency: the same rules define what the
 * pipeline is expected to produce.
 *
 * v1 covers the beachhead (English dates, USD/EU decimal separators). Locale
 * breadth grows with the fixture set.
 */

import { normalizeDate } from '@outtray/core';

export { normalizeDate };

/** A field's value type, selecting how it is normalized before comparison. */
export type FieldKind = 'text' | 'date' | 'amount';

/** NFC-normalize, case-fold, collapse internal whitespace, and trim. */
export function normalizeText(value: string | null | undefined): string {
  if (value == null) return '';
  return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Canonicalize a monetary amount to a bare number string ("$301.00" -> "301").
 *
 * Strips currency symbols and grouping separators, resolves the decimal
 * separator (rightmost of `.`/`,` when both appear), and returns the numeric
 * value as a string. Returns normalized text when the value is not a number.
 */
export function normalizeAmount(value: string | null | undefined): string {
  if (value == null) return '';
  let s = value.replace(/[^0-9.,-]/g, '');
  if (!/\d/.test(s)) return normalizeText(value); // no digits: not an amount (Number('') is 0, so guard first)

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    s = s.split(thousands).join('');
    if (decimal === ',') s = s.replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  }

  const n = Number(s);
  if (Number.isNaN(n)) return normalizeText(value);
  return String(n);
}

/** Normalize a value according to its field kind. */
export function normalizeValue(kind: FieldKind, value: string | null | undefined): string | null {
  switch (kind) {
    case 'date':
      return normalizeDate(value);
    case 'amount':
      return normalizeAmount(value);
    default:
      return normalizeText(value);
  }
}
