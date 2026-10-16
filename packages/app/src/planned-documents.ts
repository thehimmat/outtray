/**
 * The documents a plan read, as the page may show them: each with its trusted
 * type and, when its type carries an ID number, only the redacted form
 * (ADR-0011). Shared by both hosts so they list documents identically.
 */

import { IDENTIFIER_FIELDS, redactExtraction, type ScanReport } from '@outtray/core';
import type { PlannedDocument } from './api.js';

/**
 * One entry per scanned document, in scan order.
 *
 * Failure modes: none; pure. A document whose extraction failed is listed
 * with no identifier.
 */
export function plannedDocuments(report: ScanReport): PlannedDocument[] {
  return report.items.map((item) => {
    const doc = item.result.document ? redactExtraction(item.result.document) : null;
    const field = doc ? (IDENTIFIER_FIELDS[doc.type] ?? null) : null;
    const value = doc && field ? (doc as Record<string, unknown>)[field] : null;
    return {
      file: item.file,
      type: item.reconciliation.effectiveType,
      identifier: field && typeof value === 'string' ? { field, redacted: value } : null,
    };
  });
}
