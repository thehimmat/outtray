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
 * the only setting today is an opt-in and "off" is always a safe answer. The
 * reason is returned as a warning so the caller can show it instead of the
 * user wondering why the setting did not stick.
 */

import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATABASE_FILE_MODE, ensureAppDataDir } from './app-paths.js';

/** Everything the user can set. */
export interface Settings {
  /**
   * Whether full identifiers are vaulted so `outtray reveal` can show them.
   * Off by default; off means only last four are ever stored (ADR-0011).
   */
  identifierStorage: boolean;
}

/** What an absent, unreadable or partial config file means. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ identifierStorage: false });

/** Settings as read, plus why the defaults were used, if they were. */
export interface SettingsRead {
  settings: Settings;
  /** Why a stored value was ignored, or null when the file was absent or fine. */
  warning: string | null;
}

/**
 * Read the settings at `path`.
 *
 * Failure modes: never rejects. A missing file, or a file without the key,
 * reads as the defaults with no warning. A file that cannot be read or parsed,
 * or a value that is not a boolean, reads as the defaults for that value with
 * a warning naming the file. Only a literal `true` turns identifier storage on.
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      settings: { ...DEFAULT_SETTINGS },
      warning: `${path} is not valid JSON; using defaults.`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      warning: `${path} is not a JSON object; using defaults.`,
    };
  }

  const value = (parsed as Record<string, unknown>).identifierStorage;
  if (value === undefined) return { settings: { ...DEFAULT_SETTINGS }, warning: null };
  if (typeof value !== 'boolean') {
    return {
      settings: { ...DEFAULT_SETTINGS },
      warning: `identifierStorage in ${path} is not true or false; treating it as off.`,
    };
  }
  return { settings: { identifierStorage: value }, warning: null };
}

/**
 * Write `settings` to `path`, creating the data directory owner-only if needed.
 * The file is written beside the target and renamed over it, so a crash leaves
 * the old file or the new one, never half of either.
 *
 * Failure modes: rejects if the directory cannot be created owner-only or the
 * filesystem refuses the write or the rename. The previous file is intact when
 * it rejects.
 */
export async function writeSettings(path: string, settings: Settings): Promise<void> {
  const dir = await ensureAppDataDir(dirname(path));
  const temp = join(dir, `.config.json.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: DATABASE_FILE_MODE });
  await chmod(temp, DATABASE_FILE_MODE);
  await rename(temp, path);
}
