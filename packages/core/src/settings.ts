/**
 * User settings, kept in a small plaintext `config.json` beside the database
 * (issue #83, ADR-0011 amendment).
 *
 * Not in the encrypted store, on purpose: the store is a derived cache that a
 * user may delete to recover, and deleting it must not reset a privacy choice.
 * Deleting this file does reset it, to off, which is the safe direction. The
 * cost is that the file says in the clear whether identifier storage is on: a
 * boolean about a setting, never anything about a document.
 *
 * Every read failure resolves to the defaults rather than rejecting, because
 * every setting is an opt-in and "off" is always a safe answer. The reason is
 * returned as a warning so the caller can show it instead of the user
 * wondering why the setting did not stick.
 *
 * The desktop app writes the same file (ADR-0013), so a write changes only
 * the keys it is given and keeps the rest, including keys this build does not
 * know.
 */

import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATABASE_FILE_MODE, ensureAppDataDir } from './app-paths.js';
import type { StorageProvider } from './storage-provider.js';

/** Everything the user can set. */
export interface Settings {
  /**
   * Whether full identifiers are vaulted so `outtray reveal` can show them.
   * Off by default; off means only last four are ever stored (ADR-0011).
   */
  identifierStorage: boolean;
  /**
   * Whether scans read each new document with the OCR sidecar first and
   * classify from its text (ADR-0009 amendment 3). Off by default until the
   * vote on OCR text is measured; switching it re-extracts every document once.
   */
  ocr: boolean;
}

/** What an absent, unreadable or partial config file means. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  identifierStorage: false,
  ocr: false,
});

const SETTING_KEYS = ['identifierStorage', 'ocr'] as const;

/** Settings as read, plus why the defaults were used, if they were. */
export interface SettingsRead {
  settings: Settings;
  /** Why a stored value was ignored, or null when the file was absent or fine. */
  warning: string | null;
}

/**
 * Read the settings at `path`.
 *
 * Failure modes: never rejects. A missing file, or a file without a key,
 * reads as the defaults with no warning. A file that cannot be read or parsed
 * reads as the defaults with a warning naming the file; a value that is not a
 * boolean reads as off for that key alone, with a warning naming the key.
 * Only a literal `true` turns a setting on.
 */
export async function readSettings(path: string): Promise<SettingsRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: { ...DEFAULT_SETTINGS }, warning: null };
    }
    return {
      settings: { ...DEFAULT_SETTINGS },
      warning: `Could not read ${path} (${(error as Error).message}); using defaults.`,
    };
  }

  const parsed = parseObject(text);
  if (typeof parsed === 'string') {
    return { settings: { ...DEFAULT_SETTINGS }, warning: `${path} ${parsed}; using defaults.` };
  }

  const settings: Settings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];
  for (const key of SETTING_KEYS) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') settings[key] = value;
    else warnings.push(`${key} in ${path} is not true or false; treating it as off.`);
  }
  return { settings, warning: warnings.length > 0 ? warnings.join(' ') : null };
}

/** The JSON object in `text`, or why it is not one. */
function parseObject(text: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'is not valid JSON';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'is not a JSON object';
  }
  return parsed as Record<string, unknown>;
}

/**
 * Write the given settings to `path`, keeping every other key the file holds
 * (the app writes it too), and creating the data directory owner-only if
 * needed. The file is written beside the target and renamed over it, so a
 * crash leaves the old file or the new one, never half of either.
 *
 * Failure modes: rejects if the directory cannot be created owner-only or the
 * filesystem refuses the write or the rename. The previous file is intact when
 * it rejects. A file that is not a JSON object is replaced by one holding only
 * `settings`.
 */
export async function writeSettings(path: string, settings: Partial<Settings>): Promise<void> {
  const dir = await ensureAppDataDir(dirname(path));
  let existing: Record<string, unknown> = {};
  try {
    const parsed = parseObject(await readFile(path, 'utf8'));
    if (typeof parsed !== 'string') existing = parsed;
  } catch {
    // Absent or unreadable: nothing to keep.
  }
  const temp = join(dir, `.config.json.${process.pid}.tmp`);
  const body = { ...existing, ...settings };
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: DATABASE_FILE_MODE });
  await chmod(temp, DATABASE_FILE_MODE);
  await rename(temp, path);
}

/** Options for `setIdentifierStorage`. */
export interface SetIdentifierStorageOptions {
  /** Where the settings live, normally `defaultConfigPath()`. */
  configPath: string;
  /**
   * The store to purge when switching off, or null when no store exists yet
   * (nothing to purge, and opening one would create it).
   */
  storage: StorageProvider | null;
  enabled: boolean;
}

/**
 * Record the user's identifier-storage choice, purging the vault when it is
 * switched off. Switching on changes nothing in the store: values already
 * redacted are gone, and reach the vault when their documents are next
 * extracted (ADR-0011 amendment, section 3).
 *
 * Failure modes: rejects if the settings file cannot be written, in which
 * case nothing is purged and the old setting stands. If the setting is
 * written but the purge rejects, the setting is off and the next
 * `persistScan` completes the purge. A null `storage` purges nothing, which
 * is complete when no store exists.
 */
export async function setIdentifierStorage(
  options: SetIdentifierStorageOptions,
): Promise<{ purged: number }> {
  await writeSettings(options.configPath, { identifierStorage: options.enabled });
  if (options.enabled || options.storage === null) return { purged: 0 };
  return { purged: await options.storage.purgeIdentifiers() };
}
