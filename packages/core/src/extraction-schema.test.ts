import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TYPES,
  documentExtractionSchema,
  documentJsonSchema,
  validateExtraction,
} from './extraction-schema.js';

const bill = {
  type: 'bill',
  summary: 'DMV registration renewal, $301 due Aug 31.',
  action_items: [{ text: 'Pay $301.00 by Aug 31, 2026', due_date: '2026-08-31' }],
  payee: 'State DMV',
  amount_due: '$301.00',
  due_date: '2026-08-31',
  late_fee: '$54.00',
};

describe('extraction schema (ADR-0004)', () => {
  it('lists the eight document types with unknown as first-class', () => {
    expect(DOCUMENT_TYPES).toContain('unknown');
    expect(DOCUMENT_TYPES).toHaveLength(8);
  });

  it('validates a well-formed bill', () => {
    const r = validateExtraction(bill);
    expect(r.success).toBe(true);
  });

  it('routes on the type discriminant: bill fields rejected under the wrong type', () => {
    const r = validateExtraction({ ...bill, type: 'letter' });
    expect(r.success).toBe(false);
  });

  it('accepts unknown with only the shared base fields (routes to human review)', () => {
    const r = validateExtraction({
      type: 'unknown',
      summary: 'Unclassifiable scan.',
      action_items: [],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a null due_date (missing deadline is not a failure)', () => {
    const r = validateExtraction({ ...bill, due_date: null, late_fee: null });
    expect(r.success).toBe(true);
  });

  it('rejects a missing required discriminant', () => {
    const { type: _omit, ...noType } = bill;
    expect(validateExtraction(noType).success).toBe(false);
  });

  it('rejects an unknown extra document type', () => {
    expect(validateExtraction({ ...bill, type: 'invoice' }).success).toBe(false);
  });

  it('compiles to a JSON Schema oneOf covering every document type', () => {
    const schema = documentJsonSchema as { oneOf?: Array<{ properties?: { type?: { const?: string } } }> };
    expect(Array.isArray(schema.oneOf)).toBe(true);
    const discriminants = (schema.oneOf ?? []).map((b) => b.properties?.type?.const);
    for (const t of DOCUMENT_TYPES) {
      expect(discriminants).toContain(t);
    }
  });

  it('exposes the Zod schema for parse-time validation', () => {
    expect(documentExtractionSchema.safeParse(bill).success).toBe(true);
  });
});
