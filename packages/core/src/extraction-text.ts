/**
 * Flatten a structured extraction into text, shared by retrieval indexing
 * (ADR-0005) and the classification stage (ADR-0009). Until an OCR arm exists,
 * this is the pipeline's only text view of a document.
 */

import type { DocumentExtraction } from './extraction-schema.js';
import { tokenizeExtraction } from './identifiers.js';

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

/**
 * The text Outtray derives from an extraction and embeds: the flattened,
 * tokenized form, with every identifier replaced by its `[field]`
 * placeholder (ADR-0011 amendment). Chunks, classifier queries, correction
 * labels and the classification eval all embed this, so a query and the
 * examples it is compared with are always the same kind of text.
 *
 * Failure modes: none; pure. As `extractionText`, may return ''.
 */
export function derivedText(doc: DocumentExtraction): string {
  return extractionText(tokenizeExtraction(doc));
}
