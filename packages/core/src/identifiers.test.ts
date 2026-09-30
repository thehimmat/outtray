import { describe, expect, it } from 'vitest';
import type { DocumentExtraction } from './extraction-schema.js';
import { extractionText } from './extraction-text.js';
import {
  canonicalIdentifier,
  identifierOf,
  placeholderFor,
  redactExtraction,
  redactedForm,
  replaceIdentifier,
  tokenizeExtraction,
} from './identifiers.js';

const PASSPORT: DocumentExtraction = {
  type: 'id_document',
  summary: 'US passport AB1234567 for Jane Doe.',
  action_items: [{ text: 'Renew passport AB 123 4567 before travel', due_date: '2027-01-01' }],
  holder_name: 'Jane Doe',
  id_number: 'AB1234567',
  issuer: 'US Department of State',
  expiry_date: '2027-03-01',
};

const STATEMENT: DocumentExtraction = {
  type: 'statement',
  summary: 'Checking statement for account 0042-1177-89.',
  action_items: [],
  institution: 'First Bank',
  account_number: '0042-1177-89',
  period_start: '2026-06-01',
  period_end: '2026-06-30',
  balance: '$1,204.00',
};

const BILL: DocumentExtraction = {
  type: 'bill',
  summary: 'DMV renewal.',
  action_items: [{ text: 'Pay $301.00', due_date: '2026-08-31' }],
  payee: 'State DMV',
  amount_due: '$301.00',
  due_date: '2026-08-31',
  late_fee: null,
};

describe('identifierOf', () => {
  it('returns the identifier field of the three identifier-bearing types', () => {
    expect(identifierOf(PASSPORT)).toEqual({ field: 'id_number', value: 'AB1234567' });
    expect(identifierOf(STATEMENT)).toEqual({ field: 'account_number', value: '0042-1177-89' });
    const policy: DocumentExtraction = {
      type: 'policy',
      summary: 'Auto policy.',
      action_items: [],
      insurer: 'Acme',
      policy_number: 'P-998877',
      coverage_summary: 'Liability',
      expiry_date: null,
    };
    expect(identifierOf(policy)).toEqual({ field: 'policy_number', value: 'P-998877' });
  });

  it('returns null for types without an identifier field', () => {
    expect(identifierOf(BILL)).toBeNull();
  });

  it('returns null when the extracted value has no letters or digits', () => {
    expect(identifierOf({ ...PASSPORT, id_number: '  ' })).toBeNull();
    expect(identifierOf({ ...PASSPORT, id_number: '-/-' })).toBeNull();
  });
});

describe('canonicalIdentifier', () => {
  it('uppercases and strips everything but letters and digits', () => {
    expect(canonicalIdentifier(' ab-12 34.56/7 ')).toBe('AB1234567');
  });
});

describe('redactedForm', () => {
  it('shows the last four and the length for values of 8 or more characters', () => {
    expect(redactedForm('id_number', 'AB1234567')).toBe('[id_number ending 4567, 9 chars]');
  });

  it('ignores separators when taking the last four and the length', () => {
    expect(redactedForm('account_number', '0042-1177-89')).toBe(
      '[account_number ending 7789, 10 chars]',
    );
  });

  it('shows only the length for values shorter than 8 characters', () => {
    expect(redactedForm('policy_number', 'P-99887')).toBe('[policy_number, 6 chars]');
  });
});

describe('placeholderFor', () => {
  it('names the field and nothing about the value', () => {
    expect(placeholderFor('id_number')).toBe('[id_number]');
  });
});

describe('replaceIdentifier', () => {
  const R = '[X]';

  it('replaces a literal occurrence', () => {
    expect(replaceIdentifier('passport AB1234567 here', 'AB1234567', R)).toEqual({
      text: 'passport [X] here',
      count: 1,
    });
  });

  it('matches regardless of spacing, dashes and case', () => {
    expect(replaceIdentifier('no. ab 123-4567.', 'AB1234567', R).text).toBe('no. [X].');
  });

  it('matches common OCR confusions on either side', () => {
    // O/0, I/1, S/5, B/8 read interchangeably.
    expect(replaceIdentifier('ref A81234S67', 'AB1234567', R).count).toBe(1);
    expect(replaceIdentifier('acct 0042', 'OO42', R).text).toBe('acct [X]');
  });

  it('replaces every occurrence and counts them', () => {
    const result = replaceIdentifier('AB1234567 and again AB 1234567', 'AB1234567', R);
    expect(result).toEqual({ text: '[X] and again [X]', count: 2 });
  });

  it('replaces a value embedded in a longer run rather than leak it', () => {
    expect(replaceIdentifier('XAB1234567Y', 'AB1234567', R).text).toBe('X[X]Y');
  });

  it('reports zero when the value is absent, leaving text untouched', () => {
    expect(replaceIdentifier('nothing to see', 'AB1234567', R)).toEqual({
      text: 'nothing to see',
      count: 0,
    });
  });

  it('does not match inside free text for values under 4 characters', () => {
    // Too short to match without redacting unrelated text.
    expect(replaceIdentifier('page 12 of 120', '12', R)).toEqual({
      text: 'page 12 of 120',
      count: 0,
    });
  });
});

describe('tokenizeExtraction', () => {
  it('replaces the identifier field with its placeholder', () => {
    const doc = tokenizeExtraction(PASSPORT);
    expect(doc).toMatchObject({ id_number: '[id_number]' });
  });

  it('removes the value from summary and action item text', () => {
    const doc = tokenizeExtraction(PASSPORT);
    expect(doc.summary).toBe('US passport [id_number] for Jane Doe.');
    expect(doc.action_items[0]?.text).toBe('Renew passport [id_number] before travel');
  });

  it('leaves no trace of the value in the flattened text', () => {
    const text = extractionText(tokenizeExtraction(STATEMENT));
    expect(canonicalIdentifier(text)).not.toContain('0042117789');
    expect(text).toContain('account_number: [account_number]');
  });

  it('does not mutate its input', () => {
    const before = structuredClone(PASSPORT);
    tokenizeExtraction(PASSPORT);
    expect(PASSPORT).toEqual(before);
  });

  it('returns documents without an identifier unchanged', () => {
    expect(tokenizeExtraction(BILL)).toEqual(BILL);
  });
});

describe('redactExtraction', () => {
  it('replaces the field and free-text mentions with the redacted form', () => {
    const doc = redactExtraction(PASSPORT);
    expect(doc).toMatchObject({ id_number: '[id_number ending 4567, 9 chars]' });
    expect(doc.summary).toBe('US passport [id_number ending 4567, 9 chars] for Jane Doe.');
    expect(doc.action_items[0]?.text).toBe(
      'Renew passport [id_number ending 4567, 9 chars] before travel',
    );
  });

  it('keeps every non-identifier field as extracted', () => {
    const doc = redactExtraction(PASSPORT);
    expect(doc).toMatchObject({
      holder_name: 'Jane Doe',
      expiry_date: '2027-03-01',
      action_items: [{ due_date: '2027-01-01' }],
    });
  });

  it('returns documents without an identifier unchanged', () => {
    expect(redactExtraction(BILL)).toEqual(BILL);
  });
});
