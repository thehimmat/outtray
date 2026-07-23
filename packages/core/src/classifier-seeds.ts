/**
 * Seed examples and helpers for the document-type classifier (ADR-0009).
 *
 * The classifier needs labeled examples to vote against. These canonical, per-
 * type descriptions give it a cold-start neighborhood on a fresh install,
 * before the user has corrected anything; the user's own corrections are added
 * on top (`TypeClassifier.add`) and personalize it over time. Seeds are text,
 * embedded with the same provider as documents, so a document's embedding and
 * the seeds live in the same space.
 *
 * `unknown` is intentionally unseeded: it is the low-confidence fallback the
 * caller assigns when the classifier is not sure, not a class to match.
 */

import { type Classification, TypeClassifier } from './classifier.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { DocumentType } from './extraction-schema.js';

/** A canonical labeled example for cold-start classification. */
export interface SeedExample {
  type: DocumentType;
  text: string;
}

export const SEED_EXAMPLES: SeedExample[] = [
  {
    type: 'bill',
    text: 'utility bill amount due payment due date late fee account balance pay now',
  },
  { type: 'bill', text: 'invoice amount owed pay by due date past due minimum payment remittance' },
  {
    type: 'receipt',
    text: 'sales receipt merchant store total items purchased subtotal tax cash change',
  },
  {
    type: 'receipt',
    text: 'itemized purchase receipt total paid card transaction thank you for shopping',
  },
  {
    type: 'letter',
    text: 'dear sincerely regarding correspondence notice enclosed please contact our office',
  },
  { type: 'letter', text: 'to whom it may concern regards formal letter signed notification' },
  {
    type: 'id_document',
    text: 'identification card driver license number holder name date of birth expires issued state',
  },
  {
    type: 'id_document',
    text: 'passport identity document holder expiration issuing authority nationality',
  },
  {
    type: 'policy',
    text: 'insurance policy declarations coverage premium policy number effective expiration deductible insured',
  },
  {
    type: 'policy',
    text: 'policy document coverage limits insurer premium renewal expiration claims',
  },
  {
    type: 'contract',
    text: 'agreement contract parties terms conditions whereas signature effective date binding obligations',
  },
  {
    type: 'contract',
    text: 'service agreement parties hereby agree terms termination signatures governing law',
  },
  {
    type: 'statement',
    text: 'account statement period beginning ending balance transactions summary deposits withdrawals',
  },
  {
    type: 'statement',
    text: 'bank statement opening closing balance account activity interest earned',
  },
];

/**
 * Build a classifier from seed examples by embedding them.
 *
 * Failure modes: rejects if the embedder rejects. Returns a classifier seeded
 * with one labeled example per seed, ready to classify document embeddings from
 * the same provider.
 */
export async function buildClassifier(
  embedder: EmbeddingProvider,
  seeds: SeedExample[] = SEED_EXAMPLES,
): Promise<TypeClassifier> {
  const embeddings = await embedder.embed(seeds.map((s) => s.text));
  return new TypeClassifier(
    seeds.map((seed, i) => ({ type: seed.type, embedding: embeddings[i] as number[] })),
  );
}

/**
 * Embed `text` and classify it.
 *
 * Failure modes: rejects if the embedder rejects; returns null if the embedder
 * yields no vector or the classifier has no examples.
 */
export async function classifyText(
  classifier: TypeClassifier,
  embedder: EmbeddingProvider,
  text: string,
  k?: number,
): Promise<Classification | null> {
  const [embedding] = await embedder.embed([text]);
  if (!embedding) return null;
  return classifier.classify(embedding, k);
}
