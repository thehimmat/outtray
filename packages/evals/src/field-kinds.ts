/**
 * Which fields are scored per document type, and how each normalizes
 * (METHODOLOGY.md: scoring is per-field, per-type).
 *
 * Only the structured fields with a defensible ground truth are scored; free-
 * text summary and action_items are not. `type` is scored as a field too, so a
 * misclassification shows up directly as a `type` miss and, because the wrong
 * branch carries none of the expected fields, as recall loss across the rest.
 */

import type { DocumentType } from '@outtray/core';
import type { FieldKind } from './normalize.js';

export const SCORED_FIELDS: Record<DocumentType, Record<string, FieldKind>> = {
  bill: { type: 'text', payee: 'text', amount_due: 'amount', due_date: 'date', late_fee: 'amount' },
  receipt: { type: 'text', merchant: 'text', total: 'amount', purchased_at: 'date' },
  letter: { type: 'text', sender: 'text', recipient: 'text', subject: 'text', sent_date: 'date' },
  id_document: {
    type: 'text',
    holder_name: 'text',
    id_number: 'text',
    issuer: 'text',
    expiry_date: 'date',
  },
  policy: {
    type: 'text',
    insurer: 'text',
    policy_number: 'text',
    coverage_summary: 'text',
    expiry_date: 'date',
  },
  // No fixtures yet for these; only classification is scored.
  contract: { type: 'text' },
  statement: { type: 'text' },
  unknown: { type: 'text' },
};
