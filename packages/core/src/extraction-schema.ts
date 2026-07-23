/**
 * The extraction contract: per-document-type Zod schemas over a shared base
 * with a `type` discriminant (ADR-0004).
 *
 * This schema is the single source of truth for a document's extracted shape.
 * It is compiled once with `z.toJSONSchema()` into the constrained-decoding
 * `format` a `ModelProvider` sends to the runtime, and reused at parse time to
 * validate the model's output (constrained decoding guarantees shape, not
 * semantic validity, so the parse-time check stays).
 *
 * Field-level confidence is NOT part of this schema. Confidence is computed by
 * the pipeline from cross-arm agreement (ADR-0002) after extraction, layered
 * onto these values; a single model's output carries values only.
 *
 * Field sets here are v1 and expected to evolve as the fixture set grows; the
 * discriminant set (the eight types) is the stable part.
 */

import { z } from 'zod';

/** The eight document types. `unknown` is first-class and routes to human review. */
export const DOCUMENT_TYPES = [
  'letter',
  'bill',
  'receipt',
  'id_document',
  'contract',
  'policy',
  'statement',
  'unknown',
] as const;

/** An ISO 8601 date string, or null when the document states no such date. */
const isoDateOrNull = z.string().nullable();

/** One proposed action with an optional deadline (the product's action layer). */
const actionItem = z.object({
  text: z.string(),
  due_date: isoDateOrNull,
});

/** Fields present on every document type, whatever its class. */
const base = {
  summary: z.string(),
  action_items: z.array(actionItem),
};

const letter = z.object({
  type: z.literal('letter'),
  ...base,
  sender: z.string(),
  recipient: z.string(),
  subject: z.string(),
  sent_date: isoDateOrNull,
});

const bill = z.object({
  type: z.literal('bill'),
  ...base,
  payee: z.string(),
  amount_due: z.string(),
  due_date: isoDateOrNull,
  late_fee: z.string().nullable(),
});

const receipt = z.object({
  type: z.literal('receipt'),
  ...base,
  merchant: z.string(),
  total: z.string(),
  purchased_at: isoDateOrNull,
});

const idDocument = z.object({
  type: z.literal('id_document'),
  ...base,
  holder_name: z.string(),
  id_number: z.string(),
  issuer: z.string(),
  expiry_date: isoDateOrNull,
});

const contract = z.object({
  type: z.literal('contract'),
  ...base,
  parties: z.array(z.string()),
  subject: z.string(),
  effective_date: isoDateOrNull,
  termination_date: isoDateOrNull,
});

const policy = z.object({
  type: z.literal('policy'),
  ...base,
  insurer: z.string(),
  policy_number: z.string(),
  coverage_summary: z.string(),
  expiry_date: isoDateOrNull,
});

const statement = z.object({
  type: z.literal('statement'),
  ...base,
  institution: z.string(),
  account_number: z.string(),
  period_start: isoDateOrNull,
  period_end: isoDateOrNull,
  balance: z.string().nullable(),
});

const unknown = z.object({
  type: z.literal('unknown'),
  ...base,
});

/** The full extraction contract: a `type`-discriminated union over all document types. */
export const documentExtractionSchema = z.discriminatedUnion('type', [
  letter,
  bill,
  receipt,
  idDocument,
  contract,
  policy,
  statement,
  unknown,
]);

/** The extracted shape of one document. */
export type DocumentExtraction = z.infer<typeof documentExtractionSchema>;

/** A document type discriminant. */
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * The JSON Schema a provider passes as its constrained-decoding `format`.
 * Emitted as `oneOf` with a `const` discriminant per branch. The memory spike
 * confirmed Ollama's grammar compiler accepts this shape (issue #5).
 */
export const documentJsonSchema: unknown = z.toJSONSchema(documentExtractionSchema);

const branchByType = {
  letter,
  bill,
  receipt,
  id_document: idDocument,
  contract,
  policy,
  statement,
  unknown,
} as const;

/**
 * The JSON Schema for a single type's branch of the union, used as the
 * constrained-decoding `format` of a typed re-extraction (ADR-0009 amendment):
 * the grammar then forces the discriminant and that type's fields.
 *
 * Failure modes: none; every `DocumentType` has a branch.
 */
export function documentJsonSchemaFor(type: DocumentType): unknown {
  return z.toJSONSchema(branchByType[type]);
}

/**
 * Validate a model's JSON output against the extraction contract.
 *
 * Failure modes: never throws. Returns Zod's `SafeParseReturn`; callers inspect
 * `.success` and route failures (or `type: "unknown"` successes) to human
 * review rather than trusting the shape.
 */
export function validateExtraction(value: unknown) {
  return documentExtractionSchema.safeParse(value);
}
