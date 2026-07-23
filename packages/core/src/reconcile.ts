/**
 * Reconcile the VLM's one-shot document-type label with the on-device
 * classifier's vote (ADR-0009 amendment, issue #54).
 *
 * The routing is deliberately conservative pending sign-off on the amendment:
 * agreement confirms the label; a confident disagreement is surfaced as
 * `disputed` and flagged for human review, never silently auto-corrected here
 * (the proposed upgrade is a single re-extraction under the corrected
 * type-specific schema); a low-confidence disagreement trusts neither label
 * and routes to review as `unknown` (ADR-0008).
 */

import type { Classification } from './classifier.js';
import type { DocumentType } from './extraction-schema.js';

/**
 * Neighbors consulted per k-NN vote. Capped by seeds-per-type: with 2 seeds
 * per type, k=3 keeps the winning vote share meaningful, where k=5 caps it
 * under 0.5 (measured in the ADR-0009 amendment). Revisit as the label store
 * grows with user corrections.
 */
export const CLASSIFIER_K = 3;

/**
 * Winning vote share at or above which the classifier's label counts as
 * confident. Provisional (N=10, no misclassification observed yet to
 * calibrate the low side); re-measured by the classification scoreboard.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/** How a document's two type labels were reconciled. */
export type ReconciliationStatus =
  /** Classifier and VLM agree. */
  | 'confirmed'
  /** Classifier confidently disagrees; a human decides (pending issue #54). */
  | 'disputed'
  /** Classifier disagrees without confidence; neither label is trusted. */
  | 'low_confidence'
  /** No classifier verdict: stage not configured, failed, or extraction invalid. */
  | 'unclassified';

/** The pipeline's verdict on one document's type, consumed by the action layer. */
export interface Reconciliation {
  /** The working label for downstream stages; `unknown` when nothing is trusted. */
  effectiveType: DocumentType;
  status: ReconciliationStatus;
  /** True when a human should look before the item is trusted (ADR-0008). */
  review: boolean;
  /** The classifier's raw verdict, or null when it produced none. */
  classification: Classification | null;
}

/**
 * Route one document through the reconciliation table.
 *
 * `vlmType` is null when the extraction was invalid (no document to label);
 * `classification` is null when the classifier produced no verdict. Pure and
 * total: never throws, every input combination maps to a `Reconciliation`.
 */
export function reconcileType(
  vlmType: DocumentType | null,
  classification: Classification | null,
  threshold: number = CONFIDENCE_THRESHOLD,
): Reconciliation {
  if (vlmType === null) {
    return { effectiveType: 'unknown', status: 'unclassified', review: true, classification: null };
  }
  if (classification === null) {
    return { effectiveType: vlmType, status: 'unclassified', review: false, classification: null };
  }
  if (classification.type === vlmType) {
    return { effectiveType: vlmType, status: 'confirmed', review: false, classification };
  }
  if (classification.confidence >= threshold) {
    return { effectiveType: vlmType, status: 'disputed', review: true, classification };
  }
  return { effectiveType: 'unknown', status: 'low_confidence', review: true, classification };
}
