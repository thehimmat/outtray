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

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type OcrResult, ocrPlainText, parseOcrOutput } from '@outtray/core';
import { SCORED_FIELDS } from './field-kinds.js';
import type { FixtureLabels } from './fixtures/generate.js';
import {
  fixturesRoot,
  loadManifest,
  type ManifestEntry,
  type ManifestFile,
} from './fixtures/load.js';
import { sha256Hex } from './hash.js';
import { type FieldKind, normalizeAmount, normalizeDate, normalizeText } from './normalize.js';

/** Fields not scored for OCR: the discriminant, and free text no page states verbatim. */
const UNSCORED = new Set(['type', 'coverage_summary']);

/** A money amount: a currency symbol, or cents. A bare number (a day, a year) is not one. */
const AMOUNT = /-?[$€£]\s?\d(?:[\d.,]*\d)?|\b\d[\d,]*\.\d{2}\b/g;
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
  if (want === '') return false;
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(
    normalizeText(flat),
  );
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&middot;': '\u00b7',
};

/**
 * The text a fixture's HTML renders: head, style and script dropped, tags turned
 * into spaces, the common entities decoded, whitespace collapsed.
 *
 * Failure modes: none. Only good enough for the generator's own markup.
 */
export function htmlVisibleText(html: string): string {
  return html
    .replace(/<(head|style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
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
  /** Identifier fields (`IDENTIFIER_FIELDS`) read exactly. */
  identifiersFound: number;
  identifiersTotal: number;
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
  const ids = rows.flatMap((r) => r.fields.filter((f) => IDENTIFIER_FIELDS.has(f.field)));
  return {
    fixtures: rows.length,
    fieldsFound: rows.reduce((n, r) => n + r.fields.filter((f) => f.found).length, 0),
    fieldsTotal: rows.reduce((n, r) => n + r.fields.length, 0),
    wordsFound: rows.reduce((n, r) => n + r.words.found, 0),
    wordsTotal: rows.reduce((n, r) => n + r.words.total, 0),
    identifiersFound: ids.filter((f) => f.found).length,
    identifiersTotal: ids.length,
    medianMs,
    misses: rows.flatMap((r) =>
      r.fields
        .filter((f) => !f.found)
        .map((f) => ({ id: r.id, field: f.field, expected: f.expected })),
    ),
  };
}

/** How degraded a page is: the clean render, or a copy made by `degrade-fixtures.py`. */
export const OCR_LEVELS = ['clean', 'scan', 'harsh'] as const;
export type OcrLevel = (typeof OCR_LEVELS)[number];

/** Sidecar settings a run is recorded under (#160 compares them). */
export const OCR_VARIANTS = ['default', 'no-language-correction'] as const;
export type OcrVariant = (typeof OCR_VARIANTS)[number];

/** Labelled fields that are identifiers, the ones #97 needs read exactly. */
export const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set(['id_number', 'policy_number']);

/** A page the OCR eval reads: a fixture's clean render or a degraded copy of it. */
export interface OcrPage {
  /** `bill-001` for a clean render, `bill-001.harsh` for a degraded copy. */
  id: string;
  level: OcrLevel;
  /** The fixture whose labels and HTML score this page. */
  source: ManifestEntry;
  /** Image path relative to `fixtures/`. */
  imagePath: string;
  imageSha256: string;
}

/** The degraded-page manifest written by `scripts/degrade-fixtures.py`. */
export interface DegradedManifest {
  seed: number;
  levels: Record<string, Record<string, unknown>>;
  count: number;
  pages: { id: string; source: string; level: OcrLevel; image: ManifestFile }[];
}

/** Read `fixtures/degraded/manifest.json`. */
export async function loadDegradedManifest(): Promise<DegradedManifest> {
  const raw = await readFile(join(fixturesRoot(), 'degraded', 'manifest.json'), 'utf8');
  return JSON.parse(raw) as DegradedManifest;
}

/**
 * Every page the OCR eval reads: each clean fixture, then its degraded copies,
 * in manifest order.
 *
 * Failure modes: rejects when a manifest cannot be read, or when a degraded
 * page names a source fixture the clean manifest does not have.
 */
export async function loadOcrPages(): Promise<OcrPage[]> {
  const clean = await loadManifest();
  const degraded = await loadDegradedManifest();
  const byId = new Map(clean.fixtures.map((e) => [e.id, e]));
  const pages: OcrPage[] = clean.fixtures.map((e) => ({
    id: e.id,
    level: 'clean',
    source: e,
    imagePath: e.files.png.path,
    imageSha256: e.files.png.sha256,
  }));
  for (const p of degraded.pages) {
    const source = byId.get(p.source);
    if (!source) throw new Error(`Degraded page ${p.id} names unknown fixture ${p.source}`);
    pages.push({
      id: p.id,
      level: p.level,
      source,
      imagePath: p.image.path,
      imageSha256: p.image.sha256,
    });
  }
  return pages;
}

/**
 * Check every degraded image against its manifest checksum, and that no image
 * in `degraded/` is missing from the manifest.
 *
 * Failure modes: never throws for a bad file; returns the problems (empty when
 * clean). Rejects only when the manifest itself cannot be read.
 */
export async function verifyDegradedManifest(): Promise<string[]> {
  const manifest = await loadDegradedManifest();
  const root = fixturesRoot();
  const problems: string[] = [];
  const listed = new Set(manifest.pages.map((p) => p.image.path));
  for (const p of manifest.pages) {
    try {
      const sha = sha256Hex(await readFile(join(root, p.image.path)));
      if (sha !== p.image.sha256) problems.push(`${p.image.path}: checksum mismatch`);
    } catch {
      problems.push(`${p.image.path}: missing`);
    }
  }
  for (const name of await readdir(join(root, 'degraded'))) {
    if (name.endsWith('.jpg') && !listed.has(`degraded/${name}`)) {
      problems.push(`degraded/${name}: not in the manifest`);
    }
  }
  if (manifest.count !== manifest.pages.length) problems.push('count does not match pages');
  return problems;
}

/** One page's committed OCR output, and what it was produced from. */
export interface OcrRecording {
  page: string;
  variant: OcrVariant;
  /** SHA-256 of the image the sidecar read; a regenerated page makes this stale. */
  imageSha256: string;
  /** The OS the sidecar ran on (Vision's models ship with the OS). */
  host: string;
  result: OcrResult;
}

/** Recognizes one page; `imagePath` is absolute. */
export type PageRecognizer = (page: OcrPage, imagePath: string) => Promise<OcrResult>;

/** The OCR recording directory, `packages/evals/recordings/ocr`. */
export function ocrRecordingsDir(): string {
  return join(fixturesRoot(), '..', 'recordings', 'ocr');
}

/** Where one page's recording lives, relative to the recordings directory. */
export function recordingPath(variant: OcrVariant, pageId: string): string {
  return join(variant, `${pageId}.json`);
}

/**
 * A recognizer that replays committed recordings of one variant, so the OCR
 * numbers are reproducible on any platform (the sidecar itself needs macOS).
 *
 * Failure modes: the returned function rejects when a page has no recording,
 * when the recording is not valid JSON, or when it was made from a different
 * image than the manifest now lists (re-record on macOS, or let the `ocr` CI
 * job record it).
 */
export function replayRecognizer(
  variant: OcrVariant = 'default',
  dir: string = ocrRecordingsDir(),
): PageRecognizer {
  return async (page) => {
    let raw: string;
    try {
      raw = await readFile(join(dir, recordingPath(variant, page.id)), 'utf8');
    } catch {
      throw new Error(
        `No ${variant} OCR recording for ${page.id}; record it on macOS with pnpm eval:ocr record`,
      );
    }
    let recording: OcrRecording;
    try {
      recording = JSON.parse(raw) as OcrRecording;
    } catch (error) {
      throw new Error(`The OCR recording for ${page.id} is not valid JSON: ${String(error)}`);
    }
    if (recording.imageSha256 !== page.imageSha256) {
      throw new Error(
        `The OCR recording for ${page.id} was made from a different image; re-record it on macOS`,
      );
    }
    return parseOcrOutput(JSON.stringify(recording.result));
  };
}

/** A scored page, with its level. */
export interface OcrPageScore extends OcrFixtureScore {
  level: OcrLevel;
}

/**
 * Run `recognize` over `pages` (default: every page) and score each against
 * its source fixture's labels and HTML.
 *
 * Failure modes: rejects when a manifest or fixture file cannot be read, or
 * when `recognize` rejects.
 */
export async function runOcrReport(
  recognize: PageRecognizer,
  pages?: readonly OcrPage[],
): Promise<{ rows: OcrPageScore[]; results: Map<string, OcrResult> }> {
  const root = fixturesRoot();
  const rows: OcrPageScore[] = [];
  const results = new Map<string, OcrResult>();
  for (const page of pages ?? (await loadOcrPages())) {
    const labels = JSON.parse(
      await readFile(join(root, page.source.files.labels.path), 'utf8'),
    ) as FixtureLabels;
    const html = await readFile(join(root, page.source.files.html.path), 'utf8');
    const result = await recognize(page, join(root, page.imagePath));
    results.set(page.id, result);
    rows.push({ ...scoreOcrFixture(page.id, labels, html, result), level: page.level });
  }
  return { rows, results };
}

/**
 * `summarizeOcr` per level, in `OCR_LEVELS` order, for the levels present.
 *
 * Failure modes: none.
 */
export function summarizeByLevel(
  rows: readonly OcrPageScore[],
): Partial<Record<OcrLevel, OcrSummary>> {
  const out: Partial<Record<OcrLevel, OcrSummary>> = {};
  for (const level of OCR_LEVELS) {
    const at = rows.filter((r) => r.level === level);
    if (at.length > 0) out[level] = summarizeOcr(at);
  }
  return out;
}
