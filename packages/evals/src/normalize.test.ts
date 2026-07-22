import { describe, expect, it } from 'vitest';
import { normalizeAmount, normalizeDate, normalizeText, normalizeValue } from './normalize.js';

describe('normalizeText', () => {
  it('lowercases, NFC-normalizes, collapses whitespace, and trims', () => {
    expect(normalizeText('  State   DMV\n')).toBe('state dmv');
    expect(normalizeText('CAFÉ')).toBe('café');
  });
  it('treats a decomposed and composed accent as equal', () => {
    const composed = 'Café'; // é as one code point
    const decomposed = 'Café'; // e + combining acute
    expect(normalizeText(composed)).toBe(normalizeText(decomposed));
  });
  it('returns empty string for null/undefined/blank', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
    expect(normalizeText('   ')).toBe('');
  });
});

describe('normalizeDate', () => {
  it('keeps an ISO date', () => {
    expect(normalizeDate('2026-08-31')).toBe('2026-08-31');
    expect(normalizeDate('2026-08-31T00:00:00Z')).toBe('2026-08-31');
  });
  it('parses "Month D, YYYY"', () => {
    expect(normalizeDate('August 31, 2026')).toBe('2026-08-31');
    expect(normalizeDate('Jan 5, 2026')).toBe('2026-01-05');
  });
  it('parses "D Month YYYY"', () => {
    expect(normalizeDate('31 August 2026')).toBe('2026-08-31');
  });
  it('parses numeric M/D/YYYY', () => {
    expect(normalizeDate('8/31/2026')).toBe('2026-08-31');
    expect(normalizeDate('12/5/2026')).toBe('2026-12-05');
  });
  it('returns null for unparseable input', () => {
    expect(normalizeDate('sometime next year')).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});

describe('normalizeAmount', () => {
  it('strips currency symbols and canonicalizes trailing zeros', () => {
    expect(normalizeAmount('$301.00')).toBe('301');
    expect(normalizeAmount('301')).toBe('301');
    expect(normalizeAmount('$54.50')).toBe('54.5');
  });
  it('removes thousands separators when both separators are present', () => {
    expect(normalizeAmount('$1,234.56')).toBe('1234.56');
    expect(normalizeAmount('1.234,56')).toBe('1234.56'); // EU style
  });
  it('returns the cleaned lowercase text when not a number', () => {
    expect(normalizeAmount('see reverse')).toBe('see reverse');
  });
});

describe('normalizeValue dispatch', () => {
  it('routes by kind', () => {
    expect(normalizeValue('date', 'August 31, 2026')).toBe('2026-08-31');
    expect(normalizeValue('amount', '$301.00')).toBe('301');
    expect(normalizeValue('text', '  Hi  There ')).toBe('hi there');
  });
});
