import { describe, expect, it } from 'vitest';
import { generateFixtures } from './generate.js';

describe('generateFixtures', () => {
  it('is deterministic for a seed (byte-identical HTML and labels)', () => {
    expect(JSON.stringify(generateFixtures(1))).toBe(JSON.stringify(generateFixtures(1)));
  });

  it('a different seed yields a different set', () => {
    expect(JSON.stringify(generateFixtures(1))).not.toBe(JSON.stringify(generateFixtures(2)));
  });

  it('emits variantsPerType fixtures for each of the five types', () => {
    const specs = generateFixtures(1, 2);
    expect(specs).toHaveLength(10);
    const byType = new Map<string, number>();
    for (const s of specs) byType.set(s.type, (byType.get(s.type) ?? 0) + 1);
    expect([...byType.keys()].sort()).toEqual([
      'bill',
      'id_document',
      'letter',
      'policy',
      'receipt',
    ]);
    expect([...byType.values()]).toEqual([2, 2, 2, 2, 2]);
  });

  it('gives every fixture a unique id and a matching type label', () => {
    const specs = generateFixtures(1);
    const ids = specs.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of specs) {
      expect(s.labels.type).toBe(s.type);
      expect(s.html).toContain('<!doctype html>');
    }
  });

  it('labels carry the scored fields for each type', () => {
    const specs = generateFixtures(1);
    const bill = specs.find((s) => s.type === 'bill');
    expect(bill?.labels).toMatchObject({
      type: 'bill',
      payee: expect.any(String),
      amount_due: expect.stringMatching(/^\$/),
      due_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      late_fee: expect.stringMatching(/^\$/),
    });
    const id = specs.find((s) => s.type === 'id_document');
    expect(id?.labels.expiry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
