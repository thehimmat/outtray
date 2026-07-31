/**
 * Where Outtray keeps its own data (ADR-0011).
 *
 * One encrypted SQLite file under `~/Library/Application Support/outtray/`,
 * which is outside iCloud Desktop-and-Documents sync scope, so the store never
 * rides a cloud sync even when the user's documents do (THREAT_MODEL.md,
 * ADR-0007).
 *
 * macOS only, deliberately. ADR-0011 targets macOS and defers the question of a
 * non-macOS key store; inventing a Linux path here would imply a support claim
 * nobody has decided to make. Platform and home directory are injectable so
 * both branches stay testable wherever CI runs.
 */

import { chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory name under Application Support. */
export const APP_DIRECTORY = 'outtray';

/** File name of the encrypted store. */
export const DATABASE_FILE = 'outtray.db';

/** Owner-only, per ADR-0011: nothing outside this account has business reading it. */
export const APP_DIRECTORY_MODE = 0o700;

/** Owner-only for the database file itself. */
export const DATABASE_FILE_MODE = 0o600;

/** Thrown when Outtray is asked for a path on a platform it has not decided about. */
export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(
      `Outtray stores its data under macOS Application Support; this is ${platform}. ` +
        'ADR-0011 targets macOS and leaves a non-macOS store undecided.',
    );
    this.name = 'UnsupportedPlatformError';
  }
}

export interface AppPathOptions {
  /** Injected platform (for tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injected home directory (for tests). Defaults to `os.homedir()`. */
  home?: string;
}

/**
 * The directory holding Outtray's own data.
 *
 * Failure modes: throws `UnsupportedPlatformError` on anything but macOS. Pure;
 * does not touch the filesystem.
 */
export function appDataDir(options: AppPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new UnsupportedPlatformError(platform);
  }
  return join(options.home ?? homedir(), 'Library', 'Application Support', APP_DIRECTORY);
}

/**
 * The default path of the encrypted store.
 *
 * Failure modes: as `appDataDir`.
 */
export function defaultDatabasePath(options: AppPathOptions = {}): string {
  return join(appDataDir(options), DATABASE_FILE);
}

/**
 * Create `dir` if needed and make sure it is owner-only.
 *
 * The `chmod` is not redundant with `mkdir`'s mode: mkdir applies the umask, and
 * does nothing at all when the directory already exists, so it cannot on its own
 * guarantee the mode. Resolves the directory it ensured.
 *
 * Failure modes: rejects if the path exists and is not a directory, or if the
 * filesystem refuses the create or the mode change. Does not follow or repair a
 * symlink pointing elsewhere; it reports what it found.
 */
export async function ensureAppDataDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: APP_DIRECTORY_MODE });
  const info = await stat(dir);
  if (!info.isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }
  await chmod(dir, APP_DIRECTORY_MODE);
  return dir;
}
