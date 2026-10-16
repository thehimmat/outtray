/**
 * Did the OCR arm actually read the page? (#163)
 *
 * On poor photos Vision does not misread the body text, it misses it: it
 * finds the headings and the large amounts and nothing else
 * (`docs/evals/ocr-spike.md`). Its line confidence cannot tell, since it
 * reports 1.0 on misread lines. What the result itself shows is the shape
 * of the failure: little text, and only large text. This module turns that
 * into a verdict per page, so a page the OCR could not read goes to the VLM
 * (which reads the image) or is flagged for a rescan, never trusted.
 *
 * The thresholds sit in the middle of the gap between readable and
 * unreadable pages in the recorded OCR eval. They lean toward "unreadable"
 * on purpose: a false alarm costs one VLM call or one rescan prompt, while a
 * page wrongly trusted silently loses fields. A short genuine document (a
 * ticket stub) or one set in large type will be called unreadable; that is
 * the cheap direction to be wrong in.
 *
 * Host-neutral: a pure function over an `OcrResult`.
 */

import type { OcrResult } from './ocr-contract.js';

/** Why a page was judged unreadable. */
export type UnreadableReason = 'no-text' | 'too-little-text' | 'only-large-text';

export interface ReadabilityThresholds {
  /** Fewer characters than this on a page means little was read. */
  minCharacters: number;
  /**
   * A median line height (fraction of the page height) above this means
   * only large text was read. Body text on the fixtures is about 0.015.
   */
  maxMedianLineHeight: number;
}

/**
 * Calibrated on the 30 recorded pages of the OCR eval (clean and scan pages
 * read 157 to 299 characters at a median line height of 0.0146 to 0.0178;
 * harsh pages read 28 to 102 at 0.0241 to 0.0437), midway across each gap.
 * In-sample: real scans have not been measured.
 */
export const READABILITY_THRESHOLDS: ReadabilityThresholds = {
  minCharacters: 130,
  maxMedianLineHeight: 0.021,
};

export interface PageReadability {
  readable: boolean;
  reasons: UnreadableReason[];
  lines: number;
  characters: number;
  /** Median line height as a fraction of the page height, or null with no lines. */
  medianLineHeight: number | null;
}

export interface ReadabilityVerdict {
  /** True only when every page is readable. */
  readable: boolean;
  pages: PageReadability[];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Judge whether the OCR read each page of `result`.
 *
 * Failure modes: none; a page with no lines is unreadable with reason
 * `no-text`. The verdict says nothing about whether the text that was read
 * is correct, only whether enough of the page was read to rely on.
 */
export function assessReadability(
  result: OcrResult,
  thresholds: ReadabilityThresholds = READABILITY_THRESHOLDS,
): ReadabilityVerdict {
  const pages = result.pages.map((page): PageReadability => {
    const characters = page.lines.reduce((n, l) => n + l.text.length, 0);
    const medianLineHeight = median(page.lines.map((l) => l.box.height));
    const reasons: UnreadableReason[] = [];
    if (page.lines.length === 0) {
      reasons.push('no-text');
    } else {
      if (characters < thresholds.minCharacters) reasons.push('too-little-text');
      if (medianLineHeight !== null && medianLineHeight > thresholds.maxMedianLineHeight) {
        reasons.push('only-large-text');
      }
    }
    return {
      readable: reasons.length === 0,
      reasons,
      lines: page.lines.length,
      characters,
      medianLineHeight,
    };
  });
  return { readable: pages.every((p) => p.readable), pages };
}
