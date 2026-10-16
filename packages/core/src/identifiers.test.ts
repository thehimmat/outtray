import { describe, expect, it } from 'vitest';
import type { DocumentExtraction } from './extraction-schema.js';
import { derivedText, extractionText } from './extraction-text.js';
import {
  canonicalIdentifier,
  identifierOf,
  placeholderFor,
  redactExtraction,
  redactedForm,
  replaceIdentifier,
  replaceNearMisses,
  TOKENIZER_VERSION,
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

describe('redaction and tokenization are idempotent (ADR-0012 section 5)', () => {
  const SHORT: DocumentExtraction = {
    ...PASSPORT,
    summary: 'Passport X12345.',
    id_number: 'X12345',
    action_items: [],
  };

  it('redacting a redacted extraction changes nothing', () => {
    const once = redactExtraction(PASSPORT);
    expect(redactExtraction(once)).toEqual(once);
    const shortOnce = redactExtraction(SHORT);
    expect(shortOnce).toMatchObject({ id_number: '[id_number, 6 chars]' });
    expect(redactExtraction(shortOnce)).toEqual(shortOnce);
  });

  it('redacting a tokenized extraction changes nothing', () => {
    const tokenized = tokenizeExtraction(PASSPORT);
    expect(redactExtraction(tokenized)).toEqual(tokenized);
  });

  it('tokenizing a redacted extraction leaves placeholders and no last four', () => {
    const doc = tokenizeExtraction(redactExtraction(PASSPORT));
    expect(doc).toMatchObject({ id_number: '[id_number]' });
    expect(doc.summary).toBe('US passport [id_number] for Jane Doe.');
    expect(doc.action_items[0]?.text).toBe('Renew passport [id_number] before travel');
    expect(extractionText(doc)).not.toContain('4567');
  });

  it('tokenizing a tokenized extraction changes nothing', () => {
    const once = tokenizeExtraction(PASSPORT);
    expect(tokenizeExtraction(once)).toEqual(once);
  });
});

describe('derivedText', () => {
  it('is the flattened tokenized extraction, with no identifier value', () => {
    expect(derivedText(PASSPORT)).toBe(extractionText(tokenizeExtraction(PASSPORT)));
    expect(canonicalIdentifier(derivedText(PASSPORT))).not.toContain('1234567');
  });
});

describe('action item due dates (#64 findings)', () => {
  const POLICY: DocumentExtraction = {
    type: 'policy',
    summary: 'Auto policy.',
    action_items: [{ text: 'Policy number', due_date: 'POL-804220' }],
    insurer: 'Harbor Casualty',
    policy_number: 'POL-804220',
    coverage_summary: 'auto',
    expiry_date: '2026-12-16',
  };

  it('redacts and tokenizes an identifier the model put in a due date', () => {
    expect(redactExtraction(POLICY).action_items[0]?.due_date).toBe(
      '[policy_number ending 4220, 9 chars]',
    );
    expect(tokenizeExtraction(POLICY).action_items[0]?.due_date).toBe('[policy_number]');
  });
});

describe('replaceNearMisses (#97)', () => {
  const R = '[x]';

  it('redacts a run one digit short of the value', () => {
    expect(replaceNearMisses('Policy POL-76982 renews.', 'POL-769782', R)).toEqual({
      text: `Policy ${R} renews.`,
      count: 1,
    });
  });

  it('redacts a run with two digits transposed', () => {
    expect(replaceNearMisses('Account 0042117798 closed', '0042-1177-89', R).text).toBe(
      `Account ${R} closed`,
    );
  });

  it('redacts a run with one digit changed or added', () => {
    expect(replaceNearMisses('id AB1234568', 'AB1234567', R).count).toBe(1);
    expect(replaceNearMisses('id AB12345677', 'AB1234567', R).count).toBe(1);
  });

  it('redacts a run that rewrote the start but keeps the last four', () => {
    expect(replaceNearMisses('ref XY9934567', 'AB1234567', R).count).toBe(1);
  });

  it('leaves dates, amounts, words and unrelated numbers alone', () => {
    const text = 'Due 2026-08-31, pay $1,204.00 for policy renewal 55512345 by phone.';
    expect(replaceNearMisses(text, 'POL-769782', R)).toEqual({ text, count: 0 });
  });

  it('does not look for near misses of values under 8 characters', () => {
    expect(replaceNearMisses('code 12346', '12345', R).count).toBe(0);
  });

  it('leaves the redacted form it sits next to untouched', () => {
    const text = 'Policy [policy_number ending 9782, 9 chars] renews.';
    expect(replaceNearMisses(text, 'POL-769782', R)).toEqual({ text, count: 0 });
  });
});

describe('tokenize and redact remove near misses too (#97)', () => {
  const policy: DocumentExtraction = {
    type: 'policy',
    summary: 'Auto policy POL-76982 with Evergreen.',
    action_items: [{ text: 'Renew POL769872', due_date: null }],
    insurer: 'Evergreen Mutual',
    policy_number: 'POL-769782',
    coverage_summary: 'auto',
    expiry_date: '2026-12-16',
  };

  it('tokenizes a rewritten mention to the placeholder', () => {
    const text = extractionText(tokenizeExtraction(policy));
    expect(text).not.toMatch(/7698|76982|769872/);
    expect(text).toContain('Auto policy [policy_number] with Evergreen.');
  });

  it('redacts a rewritten mention to the redacted form', () => {
    const out = redactExtraction(policy);
    expect(out.summary).toBe('Auto policy [policy_number ending 9782, 9 chars] with Evergreen.');
    expect(out.action_items[0]?.text).toBe('Renew [policy_number ending 9782, 9 chars]');
  });

  it('is a new tokenizer version, so stored chunks are rebuilt', () => {
    expect(TOKENIZER_VERSION).toBe('tokenize-v2');
  });
});
