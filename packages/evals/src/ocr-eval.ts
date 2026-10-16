/**
 * OCR arm eval (issue #8): how much of each fixture the Vision sidecar reads.
 *
 * Two measures, both against ground truth the fixture set already has:
 *
 * - **Field recall**: for each scored field (`SCORED_FIELDS`, minus `type` and
 *   the free-text `coverage_summary`), is the labelled value present in the
 *   OCR text? This is an upper bound on what a text-based extractor reading
 *   this OCR could get right, and the number that decides whether the OCR arm
 *   can feed classify-first routing (ADR-0009) and identifier tokenization of
 *   OCR text (#97). A misread identifier shows up here as a miss.
 * - **Word recall**: the share of words in the rendered HTML (the exact text
 *   on the page) that appear in the OCR text, as a multiset. Coarser than a
 *   character error rate and blind to order, but it needs no alignment and it
 *   tells a missing region apart from a few misread characters.
 *
 * Values are matched after the same normalization the extraction scorer uses
 * (`normalize.ts`), so "$91.00" matches "91" and "2027-02-16" matches
 * "February 16, 2027".
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type OcrResult, ocrPlainText, parseOcrOutput } from '@outtray/core';
import { SCORED_FIELDS } from './field-kinds.js';
import type { FixtureLabels } from './fixtures/generate.js';
import { fixturesRoot, loadManifest, type ManifestEntry } from './fixtures/load.js';
import { type FieldKind, normalizeAmount, normalizeDate, normalizeText } from './normalize.js';

/** Fields not scored for OCR: the discriminant, and free text no page states verbatim. */
const UNSCORED = new Set(['type', 'coverage_summary']);

const AMOUNT = /-?[$€£]?\s?\d[\d.,]*/g;
const DATES = [
  /[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}/g,
  /\d{1,2}\s+[A-Za-z]+\.?\s+\d{4}/g,
  /\d{1,2}[/-]\d{1,2}[/-]\d{4}/g,
  /\d{4}-\d{2}-\d{2}/g,
];

/**
 * Is `expected` (a label value of the given kind) present in `text`?
 *
 * Failure modes: none; a value that normalizes to nothing is never found.
 */
export function findField(kind: FieldKind, expected: string, text: string): boolean {
  const flat = text.replace(/\s+/g, ' ');
  if (kind === 'amount') {
    const want = normalizeAmount(expected);
    return [...flat.matchAll(AMOUNT)].some((m) => normalizeAmount(m[0]) === want);
  }
  if (kind === 'date') {
    const want = normalizeDate(expected);
    if (want === null) return false;
    return DATES.some((re) =>
      [...flat.matchAll(re)].some((m) => normalizeDate(m[0].replace('.', '')) === want),
    );
  }
  const want = normalizeText(expected);
  return want !== '' && normalizeText(flat).includes(want);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * The text a fixture's HTML renders: style and script dropped, tags turned
 * into spaces, the common entities decoded, whitespace collapsed.
 *
 * Failure modes: none. Only good enough for the generator's own markup.
 */
export function htmlVisibleText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[.,:;!?()"']+|[.,:;!?()"']+$/g, ''))
    .filter((w) => w !== '');
}

/**
 * Multiset recall of `truth`'s words in `ocr`: each occurrence counts once.
 *
 * Failure modes: none; an empty truth gives `{ found: 0, total: 0 }`.
 */
export function wordRecall(truth: string, ocr: string): { found: number; total: number } {
  const pool = new Map<string, number>();
  for (const w of words(ocr)) pool.set(w, (pool.get(w) ?? 0) + 1);
  const want = words(truth);
  let found = 0;
  for (const w of want) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      found += 1;
      pool.set(w, left - 1);
    }
  }
  return { found, total: want.length };
}

export interface OcrFieldScore {
  field: string;
  expected: string;
  found: boolean;
}

export interface OcrFixtureScore {
  id: string;
  fields: OcrFieldScore[];
  words: { found: number; total: number };
  lines: number;
  /** Lowest line confidence Vision reported, or null for a page with no lines. */
  minConfidence: number | null;
  elapsedMs: number;
}

/**
 * Score one fixture's OCR result against its labels and its HTML.
 *
 * Failure modes: none; a labelled field whose value is null is skipped.
 */
export function scoreOcrFixture(
  id: string,
  labels: FixtureLabels,
  html: string,
  result: OcrResult,
): OcrFixtureScore {
  const text = ocrPlainText(result);
  const kinds = SCORED_FIELDS[labels.type];
  const fields: OcrFieldScore[] = [];
  for (const [field, kind] of Object.entries(kinds)) {
    const expected = labels[field];
    if (UNSCORED.has(field) || expected == null) continue;
    fields.push({ field, expected, found: findField(kind, expected, text) });
  }
  const lines = result.pages.flatMap((p) => p.lines);
  return {
    id,
    fields,
    words: wordRecall(htmlVisibleText(html), text),
    lines: lines.length,
    minConfidence: lines.length === 0 ? null : Math.min(...lines.map((l) => l.confidence)),
    elapsedMs: result.elapsedMs,
  };
}

export interface OcrSummary {
  fixtures: number;
  fieldsFound: number;
  fieldsTotal: number;
  wordsFound: number;
  wordsTotal: number;
  medianMs: number;
  misses: { id: string; field: string; expected: string }[];
}

/**
 * Totals over fixtures, with every missed field listed.
 *
 * Failure modes: none; no rows gives zeros and a median of 0.
 */
export function summarizeOcr(rows: readonly OcrFixtureScore[]): OcrSummary {
  const times = rows.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const medianMs =
    times.length === 0
      ? 0
      : times.length % 2 === 1
        ? (times[mid] as number)
        : ((times[mid - 1] as number) + (times[mid] as number)) / 2;
  return {
    fixtures: rows.length,
    fieldsFound: rows.reduce((n, r) => n + r.fields.filter((f) => f.found).length, 0),
    fieldsTotal: rows.reduce((n, r) => n + r.fields.length, 0),
    wordsFound: rows.reduce((n, r) => n + r.words.found, 0),
    wordsTotal: rows.reduce((n, r) => n + r.words.total, 0),
    medianMs,
    misses: rows.flatMap((r) =>
      r.fields
        .filter((f) => !f.found)
        .map((f) => ({ id: r.id, field: f.field, expected: f.expected })),
    ),
  };
}

/** One fixture's committed OCR output, and what it was produced from. */
export interface OcrRecording {
  fixture: string;
  /** SHA-256 of the page image the sidecar read; a regenerated fixture makes this stale. */
  pngSha256: string;
  /** The OS the sidecar ran on (Vision's models ship with the OS). */
  host: string;
  result: OcrResult;
}

/** Recognizes one fixture page. `entry` gives the image path and checksum. */
export type FixtureRecognizer = (entry: ManifestEntry, pngPath: string) => Promise<OcrResult>;

/** The OCR recording directory, `packages/evals/recordings/ocr`. */
export function ocrRecordingsDir(): string {
  return join(fixturesRoot(), '..', 'recordings', 'ocr');
}

/**
 * A recognizer that replays committed recordings, so the OCR numbers are
 * reproducible on any platform (the sidecar itself needs macOS).
 *
 * Failure modes: the returned function rejects when a fixture has no
 * recording, or when the recording was made from a different image than the
 * manifest now lists (re-record on macOS with `pnpm eval:ocr record`).
 */
export function replayRecognizer(dir: string = ocrRecordingsDir()): FixtureRecognizer {
  return async (entry) => {
    let recording: OcrRecording;
    try {
      recording = JSON.parse(await readFile(join(dir, `${entry.id}.json`), 'utf8')) as OcrRecording;
    } catch {
      throw new Error(
        `No OCR recording for ${entry.id}; record it on macOS with pnpm eval:ocr record`,
      );
    }
    if (recording.pngSha256 !== entry.files.png.sha256) {
      throw new Error(
        `The OCR recording for ${entry.id} was made from a different image; re-record it on macOS`,
      );
    }
    return parseOcrOutput(JSON.stringify(recording.result));
  };
}

/**
 * Run `recognize` over every manifest fixture and score it.
 *
 * Failure modes: rejects when the manifest or a fixture file cannot be read,
 * or when `recognize` rejects.
 */
export async function runOcrReport(
  recognize: FixtureRecognizer,
): Promise<{ rows: OcrFixtureScore[]; results: Map<string, OcrResult> }> {
  const manifest = await loadManifest();
  const root = fixturesRoot();
  const rows: OcrFixtureScore[] = [];
  const results = new Map<string, OcrResult>();
  for (const entry of manifest.fixtures) {
    const labels = JSON.parse(
      await readFile(join(root, entry.files.labels.path), 'utf8'),
    ) as FixtureLabels;
    const html = await readFile(join(root, entry.files.html.path), 'utf8');
    const result = await recognize(entry, join(root, entry.files.png.path));
    results.set(entry.id, result);
    rows.push(scoreOcrFixture(entry.id, labels, html, result));
  }
  return { rows, results };
}
