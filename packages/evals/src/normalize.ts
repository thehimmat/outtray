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

/** A field's value type, selecting how it is normalized before comparison. */
export type FieldKind = 'text' | 'date' | 'amount';

/** NFC-normalize, case-fold, collapse internal whitespace, and trim. */
export function normalizeText(value: string | null | undefined): string {
  if (value == null) return '';
  return value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Parse a date to ISO 8601 (YYYY-MM-DD), or null if it cannot be parsed.
 *
 * Handles: already-ISO (with optional time), "Month D, YYYY", "D Month YYYY",
 * and numeric M/D/YYYY (US order). Does not use `Date` parsing, to avoid
 * timezone drift; dates are assembled from parts.
 */
export function normalizeDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = value.trim();
  if (s === '') return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoMatch) return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));

  const lower = s.toLowerCase().replace(/,/g, '');

  // Month D YYYY
  const md = /^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/.exec(lower);
  if (md?.[1] && MONTHS[md[1]]) {
    return iso(Number(md[3]), MONTHS[md[1]] as number, Number(md[2]));
  }

  // D Month YYYY
  const dm = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/.exec(lower);
  if (dm?.[2] && MONTHS[dm[2]]) {
    return iso(Number(dm[3]), MONTHS[dm[2]] as number, Number(dm[1]));
  }

  // M/D/YYYY or M-D-YYYY (US order)
  const num = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (num) return iso(Number(num[3]), Number(num[1]), Number(num[2]));

  return null;
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
