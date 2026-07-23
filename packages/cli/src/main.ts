#!/usr/bin/env node
/**
 * Outtray CLI entry point.
 *
 * Thin by design: all domain logic lives in @outtray/core (ADR-0001). This
 * binary is the demo and dogfooding surface until the Tauri shell lands in
 * Phase 3. It reads files and prints results; it never mutates the documents it
 * scans (ADR-0008).
 *
 * Failure modes: exits 1 on an unknown command, a missing/inaccessible scan
 * directory, or an unreachable model runtime. Invalid extractions are reported
 * per file, not treated as a CLI failure.
 */

import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  type ActionQueue,
  type FindResult,
  findInDirectory,
  OllamaEmbeddingProvider,
  OllamaProvider,
  planActions,
  type ScanItem,
  type ScanReport,
  scanDirectory,
} from '@outtray/core';

// Demo embedding model. The shipped default is a later retrieval-eval ADR, the
// way ADR-0002 chose the VLM; this is just what the `find` demo runs against.
const EMBED_MODEL = 'nomic-embed-text';

const USAGE = `outtray: point it at the pile, get an action list.

Usage:
  outtray scan <dir>          Extract every document in a folder of images
  outtray actions <dir>       Scan, then propose an action queue with citations
  outtray find <dir> <query>  Retrieve the passages most relevant to a query, with citations
  outtray --version           Print version
  outtray --help              Show this help
`;

/** The bracketed type tag for one valid item, reflecting its reconciliation (ADR-0009). */
function typeTag(doc: { type: string }, reconciliation: ScanItem['reconciliation']): string {
  const c = reconciliation.classification;
  switch (reconciliation.status) {
    case 'confirmed':
      return `${doc.type}, confirmed ${c?.confidence.toFixed(2)}`;
    case 'corrected':
      return `${doc.type}, corrected from ${reconciliation.vlmType} ${c?.confidence.toFixed(2)}`;
    case 'disputed':
      return `${doc.type}, classifier says ${c?.type} ${c?.confidence.toFixed(2)}, needs review`;
    case 'low_confidence':
      return `unknown, type unclear (vlm ${doc.type} vs classifier ${c?.type} ${c?.confidence.toFixed(2)}), needs review`;
    case 'unclassified':
      return doc.type;
  }
}

/** Render a scan report as plain text for the terminal. Pure, so it is unit-tested. */
export function formatReport(dir: string, report: ScanReport): string {
  const lines: string[] = [
    `Scanned ${dir}: ${report.scanned.length} document(s), ${report.skipped.length} skipped.`,
    '',
  ];
  for (const { file, result, reconciliation } of report.items) {
    if (!result.valid || !result.document) {
      lines.push(`${file}  [could not extract: ${result.error ?? 'unknown error'}]`, '');
      continue;
    }
    const doc = result.document;
    lines.push(`${file}  [${typeTag(doc, reconciliation)}]`, `  ${doc.summary}`);
    if (doc.action_items.length > 0) {
      lines.push('  Actions:');
      for (const item of doc.action_items) {
        lines.push(`    - ${item.text} (due ${item.due_date ?? 'no date'})`);
      }
    }
    lines.push('');
  }
  if (report.classifierError !== null) {
    lines.push(
      `Classifier unavailable (${report.classifierError}); types are single-stage VLM labels.`,
    );
  } else if (report.items.some((i) => i.reconciliation.status !== 'unclassified')) {
    const flagged = report.items.filter((i) => i.reconciliation.review).length;
    lines.push(`Review: ${flagged} of ${report.items.length} item(s) flagged.`);
  }
  if (report.skipped.length > 0) {
    lines.push(`Skipped: ${report.skipped.join(', ')}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const KIND_HEADINGS: Array<[string, string]> = [
  ['attention_flag', 'Attention'],
  ['todo', 'To do'],
  ['expiry_alert', 'Expiring'],
  ['retention_advice', 'Retention advice'],
];

/** Render the proposed action queue as plain text. Pure, so it is unit-tested. */
export function formatActions(dir: string, queue: ActionQueue): string {
  const lines: string[] = [`Proposed actions for ${dir}: ${queue.items.length} item(s).`];
  lines.push(
    `${queue.flagged} item(s) flagged for attention, ${queue.needsReview} not yet reviewed by you.`,
    '',
  );
  if (queue.items.length === 0) {
    lines.push('Nothing to propose; no documents were readable.');
    return `${lines.join('\n')}\n`;
  }
  for (const [kind, heading] of KIND_HEADINGS) {
    const items = queue.items.filter((i) => i.kind === kind);
    if (items.length === 0) continue;
    lines.push(`${heading}:`);
    for (const item of items) {
      const advice = item.advice ? `${item.advice}: ` : '';
      const date = item.date ? ` (${item.date})` : '';
      const review = item.needsReviewFirst ? '  [review first]' : '';
      lines.push(`  - ${advice}${item.title}${date}${review}`);
      for (const c of item.citations) {
        lines.push(`      source: ${c.documentId}: "${c.snippet}"`);
      }
    }
    lines.push('');
  }
  lines.push(queue.disclaimer);
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Render retrieval citations as plain text. Pure, so it is unit-tested. */
export function formatCitations(query: string, result: FindResult): string {
  const lines: string[] = [
    `Query: ${query}`,
    `Scanned ${result.scanned.scanned.length} document(s).`,
    '',
  ];
  if (result.citations.length === 0) {
    lines.push('No relevant passages found.');
    return `${lines.join('\n')}\n`;
  }
  result.citations.forEach((c, i) => {
    const page = c.source.page !== undefined ? ` p${c.source.page}` : '';
    const snippet = c.text.length > 200 ? `${c.text.slice(0, 200)}...` : c.text;
    lines.push(`${i + 1}. [${c.score.toFixed(2)}] ${c.source.documentId}${page}`, `   ${snippet}`);
  });
  return `${lines.join('\n')}\n`;
}

async function runFind(args: readonly string[]): Promise<number> {
  const [dir, ...queryParts] = args;
  const query = queryParts.join(' ').trim();
  if (!dir || query === '') {
    process.stderr.write('usage: outtray find <dir> <query>\n');
    return 1;
  }
  try {
    if (!(await stat(dir)).isDirectory()) {
      process.stderr.write(`Not a directory: ${dir}\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`Cannot read directory: ${dir}\n`);
    return 1;
  }

  let result: FindResult;
  try {
    result = await findInDirectory(
      new OllamaProvider(),
      new OllamaEmbeddingProvider({ model: EMBED_MODEL }),
      dir,
      query,
      5,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `find failed: ${detail}\nIs Ollama running with qwen3-vl:2b and ${EMBED_MODEL} pulled?\n`,
    );
    return 1;
  }

  process.stdout.write(formatCitations(query, result));
  return 0;
}

/** Validate the directory argument shared by scan and actions; null when usable. */
async function directoryError(command: string, dir: string | undefined): Promise<string | null> {
  if (!dir) return `${command} needs a directory: outtray ${command} <dir>`;
  try {
    if (!(await stat(dir)).isDirectory()) return `Not a directory: ${dir}`;
  } catch {
    return `Cannot read directory: ${dir}`;
  }
  return null;
}

/** Run the two-stage scan shared by `scan` and `actions`. */
async function scanWithClassifier(dir: string): Promise<ScanReport> {
  return scanDirectory(new OllamaProvider(), dir, {
    classify: { embedder: new OllamaEmbeddingProvider({ model: EMBED_MODEL }) },
  });
}

async function runScan(args: readonly string[]): Promise<number> {
  const dir = args[0];
  const argError = await directoryError('scan', dir);
  if (argError !== null || !dir) {
    process.stderr.write(`${argError}\n`);
    return 1;
  }

  let report: ScanReport;
  try {
    report = await scanWithClassifier(dir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `scan failed: ${detail}\nIs Ollama running (ollama serve) with qwen3-vl:2b pulled?\n`,
    );
    return 1;
  }

  process.stdout.write(formatReport(dir, report));
  if (report.classifierError !== null) {
    process.stderr.write(`Hint: the classifier needs ${EMBED_MODEL} pulled in Ollama.\n`);
  }
  return 0;
}

async function runActions(args: readonly string[]): Promise<number> {
  const dir = args[0];
  const argError = await directoryError('actions', dir);
  if (argError !== null || !dir) {
    process.stderr.write(`${argError}\n`);
    return 1;
  }

  let report: ScanReport;
  try {
    report = await scanWithClassifier(dir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `actions failed: ${detail}\nIs Ollama running (ollama serve) with qwen3-vl:2b pulled?\n`,
    );
    return 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  process.stdout.write(formatActions(dir, planActions(report, { today })));
  if (report.classifierError !== null) {
    process.stderr.write(
      `Classifier unavailable (${report.classifierError}); type verdicts are single-stage.\n`,
    );
  }
  return 0;
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case '--version':
    case '-v':
      process.stdout.write('0.0.0\n');
      return 0;
    case 'scan':
      return runScan(rest);
    case 'actions':
      return runActions(rest);
    case 'find':
      return runFind(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

// Only auto-run when invoked as the binary, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
