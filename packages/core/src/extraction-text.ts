/**
 * Flatten a structured extraction into text, shared by retrieval indexing
 * (ADR-0005) and the classification stage (ADR-0009). Until an OCR arm exists,
 * this is the pipeline's only text view of a document.
 */

import type { DocumentExtraction } from './extraction-schema.js';

/**
 * Flatten a structured extraction into text.
 *
 * Failure modes: none; pure. May return an empty string for a document with
 * all-empty fields, which callers must treat as unembeddable.
 */
export function extractionText(doc: DocumentExtraction): string {
  const parts: string[] = [doc.summary];
  for (const item of doc.action_items) parts.push(item.text);
  for (const [key, value] of Object.entries(doc)) {
    if (key !== 'type' && key !== 'summary' && typeof value === 'string') {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.filter((p) => p.trim() !== '').join('. ');
}
