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
  type FindResult,
  findInDirectory,
  OllamaEmbeddingProvider,
  OllamaProvider,
  type ScanReport,
  scanDirectory,
} from '@outtray/core';

// Demo embedding model. The shipped default is a later retrieval-eval ADR, the
// way ADR-0002 chose the VLM; this is just what the `find` demo runs against.
const EMBED_MODEL = 'nomic-embed-text';

const USAGE = `outtray: point it at the pile, get an action list.

Usage:
  outtray scan <dir>          Extract an action list from a folder of document images
  outtray find <dir> <query>  Retrieve the passages most relevant to a query, with citations
  outtray --version           Print version
  outtray --help              Show this help
`;

/** Render a scan report as plain text for the terminal. Pure, so it is unit-tested. */
export function formatReport(dir: string, report: ScanReport): string {
  const lines: string[] = [
    `Scanned ${dir}: ${report.scanned.length} document(s), ${report.skipped.length} skipped.`,
    '',
  ];
  for (const { file, result } of report.items) {
    if (!result.valid || !result.document) {
      lines.push(`${file}  [could not extract: ${result.error ?? 'unknown error'}]`, '');
      continue;
    }
    const doc = result.document;
    lines.push(`${file}  [${doc.type}]`, `  ${doc.summary}`);
    if (doc.action_items.length > 0) {
      lines.push('  Actions:');
      for (const item of doc.action_items) {
        lines.push(`    - ${item.text} (due ${item.due_date ?? 'no date'})`);
      }
    }
    lines.push('');
  }
  if (report.skipped.length > 0) {
    lines.push(`Skipped: ${report.skipped.join(', ')}`);
  }
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

async function runScan(args: readonly string[]): Promise<number> {
  const dir = args[0];
  if (!dir) {
    process.stderr.write('scan needs a directory: outtray scan <dir>\n');
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

  let report: ScanReport;
  try {
    report = await scanDirectory(new OllamaProvider(), dir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `scan failed: ${detail}\nIs Ollama running (ollama serve) with qwen3-vl:2b pulled?\n`,
    );
    return 1;
  }

  process.stdout.write(formatReport(dir, report));
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
