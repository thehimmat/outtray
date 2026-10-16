/**
 * Identifier matching, tokenization and redaction (ADR-0011 section 3 and its
 * 2026-09-30 amendment).
 *
 * The extraction contract (ADR-0004) carries three identifier fields in full:
 * `id_document.id_number`, `policy.policy_number` and
 * `statement.account_number`. The full value exists in memory between the
 * model and the write path, and nowhere else by default. This module is the
 * one place that decides how it leaves:
 *
 * - `tokenizeExtraction` for text Outtray derives and indexes (chunks,
 *   embeddings): the value becomes a fixed `[field]` placeholder that does not
 *   depend on the opt-in setting, so toggling it never invalidates embeddings.
 * - `redactExtraction` for everything shown or stored as the document's
 *   extraction: the value becomes last four plus length, or length only for
 *   short values.
 *
 * Both remove the value from free text (summary, action items, other string
 * fields) as well as the named field, because the model can restate a number
 * anywhere. Matching is best-effort by nature: it ignores separators and case
 * and folds common OCR confusions, then redacts lookalikes one edit away
 * (`replaceNearMisses`), and it cannot find a value rewritten further. It
 * reduces copies; it never guarantees one.
 *
 * Pure throughout, so it is unit-tested without a model or a store.
 */

import type { DocumentExtraction, DocumentType } from './extraction-schema.js';

/**
 * Version of `tokenizeExtraction`'s output. Part of the index key (ADR-0012):
 * bump it whenever a change would tokenize the same extraction differently,
 * since chunk text and embeddings are built from that output.
 */
export const TOKENIZER_VERSION = 'tokenize-v2';

/** The extraction fields that hold a full identifier. */
export type IdentifierField = 'id_number' | 'policy_number' | 'account_number';

/** Which field carries the identifier, for the types that have one. */
export const IDENTIFIER_FIELDS: Readonly<Partial<Record<DocumentType, IdentifierField>>> = {
  id_document: 'id_number',
  policy: 'policy_number',
  statement: 'account_number',
};

/** One document's identifier: which field, and the value as extracted. */
export interface DocumentIdentifier {
  field: IdentifierField;
  value: string;
}

/**
 * Values shorter than this (after separators are stripped) are displayed as
 * length only: four characters of a five-character value is most of it.
 * Provisional, per the ADR-0011 amendment.
 */
export const MIN_LAST_FOUR_LENGTH = 8;

/**
 * Values shorter than this are not searched for in free text, because a short
 * digit run matches unrelated text (page numbers, amounts). The named field is
 * still replaced; only free-text mentions go unmatched.
 */
export const MIN_MATCH_LENGTH = 4;

/** Characters that OCR and small VLMs read interchangeably, folded for matching only. */
const OCR_FOLD: Readonly<Record<string, string>> = {
  O: '0',
  I: '1',
  L: '1',
  S: '5',
  B: '8',
  Z: '2',
};

const ALNUM = /[A-Za-z0-9]/;

/**
 * The document's identifier field and value, or null when its type has none or
 * the extracted value has no letters or digits (blank, or a placeholder like
 * `-`).
 *
 * Failure modes: none; pure.
 */
export function identifierOf(doc: DocumentExtraction): DocumentIdentifier | null {
  const field = IDENTIFIER_FIELDS[doc.type];
  if (!field) return null;
  const value = (doc as Record<string, unknown>)[field];
  if (typeof value !== 'string' || canonicalIdentifier(value) === '') return null;
  return { field, value };
}

/**
 * The value uppercased with everything but ASCII letters and digits removed.
 * This is the form last four and length are taken from.
 *
 * Failure modes: none; pure. Returns '' for a value with no letters or digits.
 */
export function canonicalIdentifier(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The OCR-folded form used for matching. Never displayed or stored. */
function matchKey(value: string): string {
  return [...canonicalIdentifier(value)].map((c) => OCR_FOLD[c] ?? c).join('');
}

/**
 * The display form of an identifier: last four plus length, or length only for
 * values shorter than `MIN_LAST_FOUR_LENGTH`. Used for every default output and
 * for the stored extraction.
 *
 * Failure modes: none; pure.
 */
export function redactedForm(field: IdentifierField, value: string): string {
  const canonical = canonicalIdentifier(value);
  const length = `${canonical.length} chars`;
  if (canonical.length < MIN_LAST_FOUR_LENGTH) return `[${field}, ${length}]`;
  return `[${field} ending ${canonical.slice(-4)}, ${length}]`;
}

/**
 * The placeholder that replaces an identifier in derived text. Names the field
 * and nothing about the value, and is the same whether identifier storage is on
 * or off (ADR-0011 amendment, section 1).
 *
 * Failure modes: none; pure.
 */
export function placeholderFor(field: IdentifierField): string {
  return `[${field}]`;
}

/**
 * Replace every occurrence of `value` in `text` with `replacement`, ignoring
 * separators and case and folding OCR confusions (O/0, I/L/1, S/5, B/8, Z/2).
 * An occurrence embedded in a longer run of letters and digits is still
 * replaced, because leaving it would leak the value.
 *
 * Failure modes: none; pure. `count` is 0 when the value is absent, when it
 * was rewritten beyond these variants, or when it is shorter than
 * `MIN_MATCH_LENGTH`. Callers that expected the value in `text` must report a
 * zero count rather than treat the text as clean.
 */
export function replaceIdentifier(
  text: string,
  value: string,
  replacement: string,
): { text: string; count: number } {
  const needle = matchKey(value);
  if (needle.length < MIN_MATCH_LENGTH) return { text, count: 0 };

  // Project the text onto its folded letters and digits, remembering where
  // each projected character came from, so a match maps back to a span of
  // the original that includes whatever separators sat inside it.
  let projected = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (!ALNUM.test(c)) continue;
    const upper = c.toUpperCase();
    projected += OCR_FOLD[upper] ?? upper;
    origin.push(i);
  }

  let out = '';
  let copied = 0;
  let count = 0;
  let from = projected.indexOf(needle);
  while (from !== -1) {
    const start = origin[from] as number;
    const end = (origin[from + needle.length - 1] as number) + 1;
    out += text.slice(copied, start) + replacement;
    copied = end;
    count += 1;
    from = projected.indexOf(needle, from + needle.length);
  }
  return { text: count === 0 ? text : out + text.slice(copied), count };
}

/** Optimal string alignment distance: edits, with an adjacent swap counting as one. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** Runs of letters and digits, joined by single hyphens, that contain a digit. */
const CANDIDATE_RUN = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;

/**
 * Replace runs in `text` that look like `value` rewritten by the model: the
 * same length give or take two, and either one edit away (a dropped, added,
 * changed or swapped character) or ending in the same last four. Meant to run
 * after `replaceIdentifier`, on what exact matching left behind; over-redacting
 * a lookalike is the safe direction (#97).
 *
 * Failure modes: none; pure. Values shorter than `MIN_LAST_FOUR_LENGTH` are
 * not searched, since a short run has too many lookalikes. A rewrite that
 * splits the value with spaces, or changes more than that, still survives.
 */
export function replaceNearMisses(
  text: string,
  value: string,
  replacement: string,
): { text: string; count: number } {
  const needle = matchKey(value);
  if (needle.length < MIN_LAST_FOUR_LENGTH) return { text, count: 0 };
  let count = 0;
  const out = text.replace(CANDIDATE_RUN, (run) => {
    if (!/\d/.test(run)) return run;
    const key = matchKey(run);
    if (Math.abs(key.length - needle.length) > 2) return run;
    const near = key.slice(-4) === needle.slice(-4) || editDistance(key, needle) <= 1;
    if (!near) return run;
    count += 1;
    return replacement;
  });
  return { text: out, count };
}

/**
 * Matches the forms this module writes in place of a value: the placeholder
 * `[field]` and the redacted `[field ending 1234, 9 chars]` or
 * `[field, 5 chars]`. Global, for replacing every one in free text.
 */
function protectedForms(field: IdentifierField): RegExp {
  return new RegExp(`\\[${field}(?: ending [A-Z0-9]{4})?(?:, \\d+ chars)?\\]`, 'g');
}

/**
 * Whether `value` is already a placeholder or redacted form rather than an
 * identifier. Stored extractions are redacted (ADR-0011 amendment) and are
 * shown again when a scan reuses them (ADR-0012), so redacting must not treat
 * its own output as a new value.
 */
function isProtectedForm(field: IdentifierField, value: string): boolean {
  const match = value.match(protectedForms(field));
  return match !== null && match[0] === value;
}

/** Rebuild `doc` with its identifier replaced everywhere by `replacement`. */
function replaceEverywhere(
  doc: DocumentExtraction,
  replacement: (id: DocumentIdentifier) => string,
): DocumentExtraction {
  const id = identifierOf(doc);
  if (!id) return doc;
  const to = replacement(id);
  // Already protected: the full value is gone, so only earlier protected
  // forms can be swapped, never a value found by matching.
  const scrub = isProtectedForm(id.field, id.value)
    ? (s: string) => s.replace(protectedForms(id.field), to)
    : (s: string) => replaceNearMisses(replaceIdentifier(s, id.value, to).text, id.value, to).text;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(doc)) {
    if (key === 'type') out[key] = v;
    else if (key === id.field) out[key] = to;
    else if (key === 'action_items') {
      // Both fields: a model can put any value, an identifier included, in either.
      out[key] = doc.action_items.map((item) => ({
        ...item,
        text: scrub(item.text),
        due_date: item.due_date === null ? null : scrub(item.due_date),
      }));
    } else if (typeof v === 'string') out[key] = scrub(v);
    else if (Array.isArray(v)) out[key] = v.map((x) => (typeof x === 'string' ? scrub(x) : x));
    else out[key] = v;
  }
  return out as DocumentExtraction;
}

/**
 * The extraction as derived, indexed text must see it: the identifier field
 * and every free-text mention of its value become `[field]`. Chunk text and
 * embeddings are built from this, never from the in-memory full extraction.
 *
 * Failure modes: none; pure, and the input is not mutated. Documents without
 * an identifier are returned as is. Mentions rewritten beyond the matched
 * variants survive in free text (see `replaceIdentifier`). An already
 * redacted extraction has its redacted forms turned into placeholders, so no
 * last four reaches derived text.
 */
export function tokenizeExtraction(doc: DocumentExtraction): DocumentExtraction {
  return replaceEverywhere(doc, (id) => placeholderFor(id.field));
}

/**
 * The extraction as every default output and the stored extraction must see
 * it: the identifier field and every free-text mention of its value become
 * the redacted form (`redactedForm`).
 *
 * Failure modes: none; pure, and the input is not mutated. Documents without
 * an identifier are returned as is, and so is an extraction already redacted
 * or tokenized. Mentions rewritten beyond the matched variants survive in
 * free text (see `replaceIdentifier`).
 */
export function redactExtraction(doc: DocumentExtraction): DocumentExtraction {
  const id = identifierOf(doc);
  // Redacting what is already redacted or tokenized changes nothing (ADR-0012).
  if (id && isProtectedForm(id.field, id.value)) return doc;
  return replaceEverywhere(doc, (found) => redactedForm(found.field, found.value));
}
