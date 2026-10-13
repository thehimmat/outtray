/**
 * Date normalization shared by the planner and the eval (ADR-0010, #64).
 *
 * The extraction contract asks for ISO dates, and a small model does not
 * always comply: "January 6, 2025" arrives where "2025-01-06" was asked for.
 * The eval already scored those as the same fact; the planner now reads them
 * the same way, so the rule that defines a correct extraction and the rule the
 * product acts on are one rule. English month names only, and numeric dates
 * in US order, as in the eval's v1 beachhead.
 */

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
 *
 * Failure modes: none; pure. Anything unparseable, including a month above 12
 * or a day above 31, is null rather than a guess.
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
