import { describe, expect, it } from 'vitest';
import { normalizeDate } from './dates.js';

describe('normalizeDate', () => {
  it.each([
    ['2026-08-31', '2026-08-31'],
    ['2026-08-31T10:00:00Z', '2026-08-31'],
    ['August 31, 2026', '2026-08-31'],
    ['Aug 31 2026', '2026-08-31'],
    ['31 August 2026', '2026-08-31'],
    ['8/31/2026', '2026-08-31'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'see page 2', 'POL-804220', '2026-13-01', 'Smarch 3, 2026'])(
    'returns null for %s',
    (input) => {
      expect(normalizeDate(input)).toBeNull();
    },
  );
});
