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
 * directory, or an unreachable model runtime; `reveal` and `settings` document
 * their own. Invalid extractions are reported
 * per file, not treated as a CLI failure.
 */

import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  type ActionQueue,
  defaultConfigPath,
  defaultDatabasePath,
  type FindResult,
  findInDirectory,
  firstRunNotice,
  IDENTIFIER_STORAGE_DISCLOSURE,
  isIdentifierField,
  KeychainKeyProvider,
  locateDocument,
  OllamaEmbeddingProvider,
  OllamaProvider,
  openSqlcipherStorage,
  persistScan,
  planActions,
  readSettings,
  redactExtraction,
  revealIdentifier,
  type ScanItem,
  type ScanReport,
  type StorageProvider,
  scanDirectory,
  setIdentifierStorage,
} from '@outtray/core';

// Demo embedding model. The shipped default is a later retrieval-eval ADR, the
// way ADR-0002 chose the VLM; this is just what the `find` demo runs against.
const EMBED_MODEL = 'nomic-embed-text';

const USAGE = `outtray: point it at the pile, get an action list.

Usage:
  outtray scan <dir>          Extract every document in a folder of images
  outtray actions <dir>       Scan, then propose an action queue with citations
  outtray find <dir> <query>  Retrieve the passages most relevant to a query, with citations
  outtray reveal <file> <field>
                              Print one stored ID number in full (id_number, policy_number,
                              account_number); needs identifier storage on
  outtray settings            Show settings and what identifier storage means
  outtray settings identifier-storage on|off [--yes]
                              Remember full ID numbers, or forget them (off by default)
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
    const doc = redactExtraction(result.document);
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

/** Where the vault commands find the settings and the store. Injected by tests. */
export interface StoreDeps {
  configPath: string;
  databasePath: string;
  /** Whether the store exists, checked before anything opens (and so creates) it. */
  databaseExists: () => Promise<boolean>;
  openStorage: () => Promise<StorageProvider>;
}

/** The real settings file and the Keychain-keyed encrypted store (ADR-0011). */
function defaultStoreDeps(): StoreDeps {
  const databasePath = defaultDatabasePath();
  return {
    configPath: defaultConfigPath(),
    databasePath,
    databaseExists: async () => {
      try {
        await stat(databasePath);
        return true;
      } catch {
        return false;
      }
    },
    openStorage: () =>
      openSqlcipherStorage({ path: databasePath, keyProvider: new KeychainKeyProvider() }),
  };
}

/** Resolve injected deps, deferring the defaults so non-macOS throws inside the caller's try. */
function resolveDeps<T>(deps: T | (() => T)): T {
  return typeof deps === 'function' ? (deps as () => T)() : deps;
}

/**
 * Save a scan to the encrypted store and return the line to show on stderr.
 * The stored extraction is always redacted; full identifiers are vaulted only
 * when the user opted in via `config.json` (ADR-0011 and its amendment). The
 * scan that creates the store also returns the first-run notice.
 *
 * Failure modes: never rejects. A store that cannot be opened or written (no
 * Keychain, not macOS, a key mismatch) is reported in the returned line, and
 * the scan output already printed stands; the store is a cache and a re-scan
 * rebuilds it. The store is closed whether or not the write succeeded.
 */
export async function saveScan(
  dir: string,
  report: ScanReport,
  deps: StoreDeps | (() => StoreDeps) = defaultStoreDeps,
): Promise<string> {
  let storage: StorageProvider | null = null;
  try {
    const { configPath, databasePath, databaseExists, openStorage } = resolveDeps(deps);
    const { settings, warning } = await readSettings(configPath);
    const firstRun = !(await databaseExists());
    storage = await openStorage();
    const summary = await persistScan(storage, report, {
      dir,
      identifierStorage: settings.identifierStorage,
    });
    const ids = settings.identifierStorage
      ? `${summary.identifiersVaulted} stored in full (identifier storage is on)`
      : 'last four only (identifier storage is off)';
    const notice = firstRun ? firstRunNotice(settings.identifierStorage, databasePath) : '';
    const saved = `Saved ${summary.documents} document(s) to the encrypted store. ID numbers: ${ids}.\n`;
    return `${notice}${warning === null ? '' : `${warning}\n`}${saved}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Not saved to the encrypted store: ${detail}\n`;
  } finally {
    await storage?.close();
  }
}

/**
 * `outtray reveal <file> <field>`: print one vaulted identifier in full
 * (ADR-0011 section 3). The value goes to stdout alone, so it can be piped,
 * and never to stderr, which is where diagnostics and logs go.
 *
 * Failure modes: exits 1 without opening the store for bad arguments or when
 * no store exists (opening would create one). Exits 1 when the file matches no
 * stored document, when the document carries a different field, or when
 * nothing is vaulted for it, saying which and what to do. Exits 1 if the store
 * cannot be opened. The store is closed on every path.
 */
export async function runReveal(
  args: readonly string[],
  deps: StoreDeps | (() => StoreDeps) = defaultStoreDeps,
): Promise<number> {
  const [file, field] = args;
  if (!file || !field) {
    process.stderr.write('usage: outtray reveal <file> <field>\n');
    return 1;
  }
  if (!isIdentifierField(field)) {
    process.stderr.write(
      `Not an identifier field: ${field}. Use one of: id_number, policy_number, account_number.\n`,
    );
    return 1;
  }

  let storage: StorageProvider | null = null;
  try {
    const { configPath, databaseExists, openStorage } = resolveDeps(deps);
    if (!(await databaseExists())) {
      process.stderr.write('Nothing has been saved yet; run `outtray scan <dir>` first.\n');
      return 1;
    }
    storage = await openStorage();
    const document = await locateDocument(storage, file);
    if (document === null) {
      process.stderr.write(
        `No scanned document matches ${file}. Scan its folder with \`outtray scan\` first.\n`,
      );
      return 1;
    }
    const result = await revealIdentifier(storage, document, field);
    switch (result.status) {
      case 'revealed':
        process.stdout.write(`${result.value}\n`);
        return 0;
      case 'wrong_field':
        process.stderr.write(
          result.documentField
            ? `${file} carries ${result.documentField}, not ${field}.\n`
            : `${file} has no ID number field.\n`,
        );
        return 1;
    }
    // not_stored: say why, from the setting as it is now.
    const { settings } = await readSettings(configPath);
    const shown = result.redacted ? ` Stored: ${result.redacted}.` : '';
    process.stderr.write(
      settings.identifierStorage
        ? `Not stored for ${file} yet.${shown} Numbers are remembered from the next scan of each document; re-scan its folder.\n`
        : `Not stored: identifier storage is off, so only the last four are kept.${shown} See \`outtray settings\`.\n`,
    );
    return 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`reveal failed: ${detail}\n`);
    return 1;
  } finally {
    await storage?.close();
  }
}

/** `runSettings` needs to know whether it can ask, and how. Injected by tests. */
export interface SettingsDeps extends StoreDeps {
  /** Whether a person is at the terminal to answer a prompt. */
  interactive: boolean;
  /** Ask a yes/no question; resolves true only on yes. */
  confirm: (question: string) => Promise<boolean>;
}

function defaultSettingsDeps(): SettingsDeps {
  return {
    ...defaultStoreDeps(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

const SETTINGS_USAGE = 'usage: outtray settings [identifier-storage on|off [--yes]]\n';

/**
 * `outtray settings`: show the identifier-storage setting with its
 * disclosure, or switch it (ADR-0011, issue #83).
 *
 * Turning it on shows the disclosure and asks first, because that is the
 * direction that keeps more; without a terminal it needs `--yes` rather than
 * assuming one. Turning it off does not ask: it is the safe direction, and it
 * deletes every vaulted number.
 *
 * Failure modes: exits 1 on an unknown setting or value, when turning on
 * without a terminal or `--yes`, or when the settings file cannot be written
 * (the old setting stands). Turning off never creates a store; if one exists
 * but cannot be opened, the setting is still saved, exit is 1, and the next
 * scan completes the purge.
 */
export async function runSettings(
  args: readonly string[],
  deps: SettingsDeps | (() => SettingsDeps) = defaultSettingsDeps,
): Promise<number> {
  const [name, value, ...flags] = args;
  if (
    name !== undefined &&
    (name !== 'identifier-storage' || (value !== 'on' && value !== 'off'))
  ) {
    process.stderr.write(SETTINGS_USAGE);
    return 1;
  }
  try {
    const resolved = resolveDeps(deps);
    if (name === undefined) {
      const { settings, warning } = await readSettings(resolved.configPath);
      if (warning !== null) process.stderr.write(`${warning}\n`);
      process.stdout.write(
        `identifier-storage: ${settings.identifierStorage ? 'on' : 'off'}\n\n` +
          `${IDENTIFIER_STORAGE_DISCLOSURE}\n` +
          'Change it with `outtray settings identifier-storage on` or `off`.\n',
      );
      return 0;
    }
    return value === 'on'
      ? await turnIdentifierStorageOn(resolved, flags.includes('--yes'))
      : await turnIdentifierStorageOff(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`settings failed: ${detail}\n`);
    return 1;
  }
}

async function turnIdentifierStorageOn(deps: SettingsDeps, yes: boolean): Promise<number> {
  if ((await readSettings(deps.configPath)).settings.identifierStorage) {
    process.stdout.write('Identifier storage is already on.\n');
    return 0;
  }
  process.stdout.write(`${IDENTIFIER_STORAGE_DISCLOSURE}\n`);
  if (!yes) {
    if (!deps.interactive) {
      process.stderr.write(
        'Not changed: no terminal to confirm at. Re-run with --yes to turn it on.\n',
      );
      return 1;
    }
    if (!(await deps.confirm('Turn identifier storage on? [y/N] '))) {
      process.stdout.write('Not changed; identifier storage is still off.\n');
      return 0;
    }
  }
  await setIdentifierStorage({ configPath: deps.configPath, storage: null, enabled: true });
  process.stdout.write(
    'Identifier storage is on. ID numbers are remembered from the next scan of each document.\n',
  );
  return 0;
}

async function turnIdentifierStorageOff(deps: SettingsDeps): Promise<number> {
  if (!(await deps.databaseExists())) {
    await setIdentifierStorage({ configPath: deps.configPath, storage: null, enabled: false });
    process.stdout.write('Identifier storage is off. Nothing was stored.\n');
    return 0;
  }
  let storage: StorageProvider;
  try {
    storage = await deps.openStorage();
  } catch (error) {
    await setIdentifierStorage({ configPath: deps.configPath, storage: null, enabled: false });
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Identifier storage is off, but stored numbers could not be deleted now (${detail}); the next scan deletes them.\n`,
    );
    return 1;
  }
  try {
    const { purged } = await setIdentifierStorage({
      configPath: deps.configPath,
      storage,
      enabled: false,
    });
    process.stdout.write(`Identifier storage is off. Deleted ${purged} stored ID number(s).\n`);
    return 0;
  } finally {
    await storage.close();
  }
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
  process.stderr.write(await saveScan(dir, report));
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
    case 'reveal':
      return runReveal(rest);
    case 'settings':
      return runSettings(rest);
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
