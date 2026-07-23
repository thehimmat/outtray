/**
 * Reconcile the VLM's one-shot document-type label with the on-device
 * classifier's vote (ADR-0009 amendment, accepted in issue #54).
 *
 * Agreement confirms the label. A confident disagreement starts as `disputed`;
 * the scan pipeline then attempts exactly one typed re-extraction under the
 * classifier's schema branch and upgrades the item to `corrected` when it
 * validates as that type, leaving it `disputed` for human review otherwise.
 * A low-confidence disagreement trusts neither label and routes to review as
 * `unknown` (ADR-0008).
 */

import type { Classification } from './classifier.js';
import type { ExtractResult } from './extract.js';
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
  /** Classifier confidently disagreed and a typed re-extraction validated. */
  | 'corrected'
  /** Classifier confidently disagrees and no correction validated; a human decides. */
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
  /** The VLM's original one-shot label (provenance), or null if extraction failed. */
  vlmType: DocumentType | null;
  /** The classifier's raw verdict, or null when it produced none. */
  classification: Classification | null;
}

/**
 * Route one document through the reconciliation table.
 *
 * `vlmType` is null when the extraction was invalid (no document to label);
 * `classification` is null when the classifier produced no verdict. Never
 * returns `corrected`: that upgrade is applied by the scan pipeline after a
 * typed re-extraction validates. Pure and total: never throws, every input
 * combination maps to a `Reconciliation`.
 */
export function reconcileType(
  vlmType: DocumentType | null,
  classification: Classification | null,
  threshold: number = CONFIDENCE_THRESHOLD,
): Reconciliation {
  if (vlmType === null) {
    return {
      effectiveType: 'unknown',
      status: 'unclassified',
      review: true,
      vlmType: null,
      classification: null,
    };
  }
  if (classification === null) {
    return {
      effectiveType: vlmType,
      status: 'unclassified',
      review: false,
      vlmType,
      classification: null,
    };
  }
  if (classification.type === vlmType) {
    return { effectiveType: vlmType, status: 'confirmed', review: false, vlmType, classification };
  }
  if (classification.confidence >= threshold) {
    return { effectiveType: vlmType, status: 'disputed', review: true, vlmType, classification };
  }
  return {
    effectiveType: 'unknown',
    status: 'low_confidence',
    review: true,
    vlmType,
    classification,
  };
}

/**
 * Upgrade a disputed reconciliation after its one typed re-extraction attempt
 * (accepted ADR-0009 amendment). The correction rule lives here so the scan
 * pipeline and the classification eval cannot drift apart.
 *
 * Returns a `corrected` reconciliation when `retry` validated as the disputed
 * classification's type; returns `reconciliation` unchanged (same reference)
 * for a non-disputed input or a retry that failed or came back off-type, so
 * callers can detect the upgrade by identity. Pure, never throws.
 */
export function applyCorrection(
  reconciliation: Reconciliation,
  retry: ExtractResult,
): Reconciliation {
  const target = reconciliation.classification?.type;
  if (reconciliation.status !== 'disputed' || !target) return reconciliation;
  if (!retry.valid || retry.document?.type !== target) return reconciliation;
  return { ...reconciliation, effectiveType: target, status: 'corrected', review: false };
}
