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
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  type ActionQueue,
  correctDocument,
  type EmbeddingProvider,
  explainStorageError,
  type FindResult,
  firstRunNotice,
  IDENTIFIER_STORAGE_DISCLOSURE,
  indexKeyFor,
  isIdentifierField,
  type ModelProvider,
  type OcrRecognizer,
  OllamaEmbeddingProvider,
  OllamaProvider,
  PINNABLE_TYPES,
  planActions,
  redactExtraction,
  revealIdentifier,
  type ScanItem,
  type ScanReport,
  type ScanWithStoreResult,
  type StorageProvider,
  scanWithStore,
  searchReport,
  searchStore,
} from '@outtray/core';
import {
  defaultConfigPath,
  defaultDatabasePath,
  folderSource,
  KeychainKeyProvider,
  locateFile,
  openSqlcipherStorage,
  readSettings,
  setIdentifierStorage,
  VisionOcr,
  visionRecognizer,
  writeSettings,
} from '@outtray/core/node';

// Demo embedding model. The shipped default is a later retrieval-eval ADR, the
// way ADR-0002 chose the VLM; this is just what the `find` demo runs against.
const EMBED_MODEL = 'nomic-embed-text';

// The extraction model (ADR-0002), passed explicitly so the extractor key that
// decides reuse (ADR-0012) names the model that actually ran.
const EXTRACT_MODEL = 'qwen3-vl:2b';

const USAGE = `outtray: point it at the pile, get an action list.

Usage:
  outtray scan <dir>          Extract every document in a folder of images
  outtray actions <dir>       Scan, then propose an action queue with citations
  outtray find <dir> <query>  Retrieve the passages most relevant to a query, with citations
  outtray reveal <file> <field> [--to-pipe]
                              Print one stored ID number in full (id_number, policy_number,
                              account_number); needs identifier storage on. --to-pipe
                              allows output to a pipe or file
  outtray correct <file> <type>
                              Mark a document's type yourself; Outtray learns from it
  outtray settings            Show settings and what identifier storage means
  outtray settings identifier-storage on|off [--yes]
                              Remember full ID numbers, or forget them (off by default)
  outtray settings ocr on|off Read each document's text with the OCR sidecar first and
                              classify from it (off by default; macOS)
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
    case 'routed':
      return `${doc.type}, read from its text ${c?.confidence.toFixed(2)}`;
    case 'user':
      return reconciliation.review
        ? `${reconciliation.effectiveType}, set by you, could not be read as one yet, needs review`
        : `${reconciliation.effectiveType}, set by you`;
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
  const argError = await directoryError('find', dir);
  if (argError !== null) {
    process.stderr.write(`${argError}\n`);
    return 1;
  }

  let found: { result: FindResult; notes: string };
  try {
    found = await findInFolder(dir, query, ollamaModels());
  } catch (error) {
    process.stderr.write(
      `find failed: ${messageOf(error)}${scanHint(error, `${EXTRACT_MODEL} and ${EMBED_MODEL}`)}\n`,
    );
    return 1;
  }

  process.stdout.write(formatCitations(query, found.result));
  process.stderr.write(found.notes);
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

/** The two models a scan uses, and the OCR arm when the setting is on. Injected by tests. */
export interface ScanModels {
  provider: ModelProvider;
  embedder: EmbeddingProvider;
  /**
   * The recognizer for a folder, started only when the `ocr` setting is on
   * (ADR-0009 amendment 3). Rejects when the OCR arm cannot run here.
   */
  ocr?: (dir: string) => Promise<OcrRecognizer>;
}

/** The local Ollama models (ADR-0002), and the Vision sidecar (`OUTTRAY_OCR_BINARY`, else on PATH). */
function ollamaModels(): ScanModels {
  return {
    provider: new OllamaProvider(),
    embedder: new OllamaEmbeddingProvider({ model: EMBED_MODEL }),
    ocr: async (dir) => {
      const binary = process.env.OUTTRAY_OCR_BINARY;
      const vision = new VisionOcr(binary ? { binary } : {});
      await vision.probe();
      return visionRecognizer(dir, vision);
    },
  };
}

/** The `ocr` setting is on and the OCR arm cannot run; nothing was scanned. */
class OcrSettingError extends Error {}

/** What to add after a failed scan: the Ollama hint, unless the OCR arm was the problem. */
function scanHint(error: unknown, models: string): string {
  return error instanceof OcrSettingError
    ? ''
    : `\nIs Ollama running (ollama serve) with ${models} pulled?`;
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

/** A scanned folder, the store it was saved to (open; the caller closes it), and what to say on stderr. */
export interface FolderScan {
  report: ScanReport;
  /** The open store, or null when it could not be opened. */
  storage: StorageProvider | null;
  /** Lines for stderr: warnings, the first-run notice, what was saved. */
  notes: string;
}

/**
 * Scan `dir` incrementally against the encrypted store and save the result
 * (ADR-0011, ADR-0012). Files whose bytes, model, prompts and index are
 * unchanged are reused with no model call; the rest are extracted, chunked,
 * embedded and saved. Stored extractions are always redacted, and full
 * identifiers are vaulted only when the user opted in. The scan that creates
 * the store also notes the first-run notice.
 *
 * Failure modes: rejects only when the scan itself fails (the vision model is
 * unreachable for a file that needs extracting), closing the store first.
 * A store that cannot be opened or written (no Keychain, not macOS, a key
 * mismatch) is reported in `notes` and the scan proceeds without it; the store
 * is a cache and a re-scan rebuilds it. An embedder failure saves documents
 * unindexed, noted, so they are read again next time. With the `ocr` setting
 * on, rejects before any model call when the OCR arm cannot run (not macOS,
 * no sidecar), rather than scanning without it: that would change every
 * document's extractor key and re-extract the whole store.
 */
export async function scanFolder(
  dir: string,
  models: ScanModels,
  deps: StoreDeps | (() => StoreDeps) = defaultStoreDeps,
): Promise<FolderScan> {
  let storage: StorageProvider | null = null;
  let identifierStorage = false;
  let ocrOn = false;
  let warning = '';
  let notice = '';
  let notes = '';
  let databasePath = 'the encrypted store';
  try {
    const resolved = resolveDeps(deps);
    databasePath = resolved.databasePath;
    const read = await readSettings(resolved.configPath);
    identifierStorage = read.settings.identifierStorage;
    ocrOn = read.settings.ocr;
    if (read.warning !== null) warning = `${read.warning}\n`;
    const firstRun = !(await resolved.databaseExists());
    storage = await resolved.openStorage();
    if (firstRun) notice = firstRunNotice(identifierStorage, resolved.databasePath);
  } catch (error) {
    notes = `Not saved to the encrypted store: ${explainStorageError(error, databasePath)}\n`;
  }

  let ocr: OcrRecognizer | undefined;
  if (ocrOn) {
    try {
      if (!models.ocr) throw new Error('No OCR arm is available in this build.');
      ocr = await models.ocr(dir);
    } catch (error) {
      await storage?.close();
      throw new OcrSettingError(
        `OCR is on and cannot run here: ${messageOf(error)} Put outtray-ocr on PATH ` +
          '(or set OUTTRAY_OCR_BINARY), or run `outtray settings ocr off` to scan without it.',
      );
    }
  }

  let scan: ScanWithStoreResult;
  try {
    scan = await scanWithStore({
      provider: models.provider,
      embedder: models.embedder,
      source: folderSource(dir),
      storage,
      identifierStorage,
      extractModel: EXTRACT_MODEL,
      embedModel: EMBED_MODEL,
      ...(ocr ? { ocr } : {}),
    });
  } catch (error) {
    await storage?.close();
    throw error;
  }
  const { report, saved, indexError, saveError } = scan;
  if (storage === null) return { report, storage, notes };

  if (saved === null) {
    notes = `${warning}Not saved to the encrypted store: ${explainStorageError(saveError, databasePath)}\n`;
  } else {
    const ids = identifierStorage
      ? `${saved.identifiersVaulted} stored in full (identifier storage is on)`
      : 'last four only (identifier storage is off)';
    const unchanged = saved.reused > 0 ? ` (${saved.reused} unchanged since the last scan)` : '';
    const index =
      indexError === null
        ? ''
        : `Search index not updated (${indexError}); these documents are read again next time.\n`;
    notes = `${notice}${warning}Saved ${saved.documents} document(s) to the encrypted store${unchanged}. ID numbers: ${ids}.\n${index}`;
  }
  return { report, storage, notes };
}

/**
 * `find`: scan `dir` incrementally, then answer `query` from the stored index
 * (ADR-0012 section 4). Over an unchanged folder no vision model loads; only
 * the query is embedded. Without a store it falls back to an in-memory index
 * of this scan, as before #43.
 *
 * Failure modes: as `scanFolder`, plus rejects if the embedder rejects while
 * searching. The store is closed on every path.
 */
export async function findInFolder(
  dir: string,
  query: string,
  models: ScanModels,
  deps: StoreDeps | (() => StoreDeps) = defaultStoreDeps,
): Promise<{ result: FindResult; notes: string }> {
  const { report, storage, notes } = await scanFolder(dir, models, deps);
  try {
    const citations = storage
      ? await searchStore(storage, models.embedder, query, 5, {
          documents: new Map(report.items.map((i) => [i.contentHash, i.file])),
          indexKey: indexKeyFor(EMBED_MODEL),
        })
      : await searchReport(models.embedder, report, query, 5);
    return { result: { citations, scanned: report }, notes };
  } finally {
    await storage?.close();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `runReveal` also needs to know where stdout goes. Injected by tests. */
export interface RevealDeps extends StoreDeps {
  /** Whether stdout is a terminal, rather than a pipe or a file. */
  stdoutIsTerminal: boolean;
}

function defaultRevealDeps(): RevealDeps {
  return { ...defaultStoreDeps(), stdoutIsTerminal: Boolean(process.stdout.isTTY) };
}

/** The flag that allows `reveal` to write a full value into a pipe or file (#101). */
const TO_PIPE_FLAG = '--to-pipe';

/**
 * `outtray reveal <file> <field> [--to-pipe]`: print one vaulted identifier in
 * full (ADR-0011 section 3). The value goes to stdout alone and never to
 * stderr, which is where diagnostics and logs go. When stdout is not a
 * terminal it refuses unless `--to-pipe` is given (#101), so an accidental
 * redirect to a file or a logged pipeline fails closed, while a deliberate
 * `--to-pipe | pbcopy` still works.
 *
 * Failure modes: exits 1 without opening the store for bad arguments, for a
 * non-terminal stdout without `--to-pipe`, or when no store exists (opening
 * would create one). Exits 1 when the file matches no stored document, when
 * the document carries a different field, or when nothing is vaulted for it,
 * saying which and what to do. Exits 1 if the store cannot be opened. The
 * store is closed on every path.
 */
export async function runReveal(
  args: readonly string[],
  deps: RevealDeps | (() => RevealDeps) = defaultRevealDeps,
): Promise<number> {
  const toPipe = args.includes(TO_PIPE_FLAG);
  const [file, field] = args.filter((a) => a !== TO_PIPE_FLAG);
  if (!file || !field) {
    process.stderr.write('usage: outtray reveal <file> <field> [--to-pipe]\n');
    return 1;
  }
  if (!isIdentifierField(field)) {
    process.stderr.write(
      `Not an identifier field: ${field}. Use one of: id_number, policy_number, account_number.\n`,
    );
    return 1;
  }

  let storage: StorageProvider | null = null;
  let databasePath = 'the encrypted store';
  try {
    const { configPath, databaseExists, openStorage, stdoutIsTerminal, ...rest } =
      resolveDeps(deps);
    databasePath = rest.databasePath;
    if (!stdoutIsTerminal && !toPipe) {
      process.stderr.write(
        `Not revealed: output is going to a pipe or file, not a terminal. Add ${TO_PIPE_FLAG} if that is intended (e.g. ${TO_PIPE_FLAG} | pbcopy).\n`,
      );
      return 1;
    }
    if (!(await databaseExists())) {
      process.stderr.write('Nothing has been saved yet; run `outtray scan <dir>` first.\n');
      return 1;
    }
    storage = await openStorage();
    const document = await locateFile(storage, file);
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
    process.stderr.write(`reveal failed: ${explainStorageError(error, databasePath)}\n`);
    return 1;
  } finally {
    await storage?.close();
  }
}

/**
 * `outtray correct <file> <type>`: pin a document's type (#67). The pin wins
 * over the classifier on every later scan; the correction becomes a labeled
 * example the classifier learns from; and when the stored extraction is of
 * another type, the next scan reads the document again under the pinned one.
 * Needs no model.
 *
 * Failure modes: exits 1 without opening the store for bad arguments or when
 * no store exists. Exits 1 when the file matches no stored document or the
 * store cannot be opened or written. The store is closed on every path.
 */
export async function runCorrect(
  args: readonly string[],
  deps: StoreDeps | (() => StoreDeps) = defaultStoreDeps,
): Promise<number> {
  const [file, type] = args;
  if (!file || !type) {
    process.stderr.write('usage: outtray correct <file> <type>\n');
    return 1;
  }
  const pinned = PINNABLE_TYPES.find((t) => t === type);
  if (!pinned) {
    process.stderr.write(
      `Not a document type: ${type}. Use one of: ${PINNABLE_TYPES.join(', ')}.\n`,
    );
    return 1;
  }

  let storage: StorageProvider | null = null;
  let databasePath = 'the encrypted store';
  try {
    const resolved = resolveDeps(deps);
    databasePath = resolved.databasePath;
    const { databaseExists, openStorage } = resolved;
    if (!(await databaseExists())) {
      process.stderr.write('Nothing has been saved yet; run `outtray scan <dir>` first.\n');
      return 1;
    }
    storage = await openStorage();
    const document = await locateFile(storage, file);
    if (document === null) {
      process.stderr.write(
        `No scanned document matches ${file}. Scan its folder with \`outtray scan\` first.\n`,
      );
      return 1;
    }
    const outcome = await correctDocument(storage, document, pinned);
    const name = basename(file);
    const reread = outcome.reextract ? ` The next scan reads it again as ${pinned}.` : '';
    const learned = outcome.learned
      ? 'Outtray will use it as an example for documents like it.\n'
      : '';
    process.stdout.write(`${name} is now marked ${pinned}.${reread}\n${learned}`);
    return 0;
  } catch (error) {
    process.stderr.write(`correct failed: ${explainStorageError(error, databasePath)}\n`);
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

const SETTINGS_USAGE = 'usage: outtray settings [identifier-storage on|off [--yes] | ocr on|off]\n';

/** What the `ocr` setting does, shown with it. */
const OCR_SETTING_NOTE =
  'ocr reads each new document with the OCR sidecar (macOS; outtray-ocr on PATH, or\n' +
  'OUTTRAY_OCR_BINARY) before the vision model and classifies it from that text; a\n' +
  'confidently known type gets one vision call.\n' +
  'Off by default while its accuracy is measured. Switching it extracts every document once more.\n';

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
    ((name !== 'identifier-storage' && name !== 'ocr') || (value !== 'on' && value !== 'off'))
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
          'Change it with `outtray settings identifier-storage on` or `off`.\n' +
          `\nocr: ${settings.ocr ? 'on' : 'off'}\n\n${OCR_SETTING_NOTE}` +
          'Change it with `outtray settings ocr on` or `off`.\n',
      );
      return 0;
    }
    if (name === 'ocr') {
      const on = value === 'on';
      if ((await readSettings(resolved.configPath)).settings.ocr === on) {
        process.stdout.write(`OCR is already ${value}.\n`);
        return 0;
      }
      // Changes nothing stored and keeps nothing more, so it asks nothing.
      await writeSettings(resolved.configPath, { ocr: on });
      process.stdout.write(
        value === 'on'
          ? 'OCR is on. Each document is extracted once more on its next scan, text first.\n'
          : 'OCR is off. Each document is extracted once more on its next scan, as before.\n',
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

  let scan: FolderScan;
  try {
    scan = await scanFolder(dir, ollamaModels());
  } catch (error) {
    process.stderr.write(`scan failed: ${messageOf(error)}${scanHint(error, EXTRACT_MODEL)}\n`);
    return 1;
  }
  await scan.storage?.close();

  process.stdout.write(formatReport(dir, scan.report));
  if (scan.report.classifierError !== null) {
    process.stderr.write(`Hint: the classifier needs ${EMBED_MODEL} pulled in Ollama.\n`);
  }
  process.stderr.write(scan.notes);
  return 0;
}

async function runActions(args: readonly string[]): Promise<number> {
  const dir = args[0];
  const argError = await directoryError('actions', dir);
  if (argError !== null || !dir) {
    process.stderr.write(`${argError}\n`);
    return 1;
  }

  let scan: FolderScan;
  try {
    scan = await scanFolder(dir, ollamaModels());
  } catch (error) {
    process.stderr.write(`actions failed: ${messageOf(error)}${scanHint(error, EXTRACT_MODEL)}\n`);
    return 1;
  }
  await scan.storage?.close();

  const today = new Date().toISOString().slice(0, 10);
  process.stdout.write(formatActions(dir, planActions(scan.report, { today })));
  if (scan.report.classifierError !== null) {
    process.stderr.write(
      `Classifier unavailable (${scan.report.classifierError}); type verdicts are single-stage.\n`,
    );
  }
  process.stderr.write(scan.notes);
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
    case 'correct':
      return runCorrect(rest);
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
