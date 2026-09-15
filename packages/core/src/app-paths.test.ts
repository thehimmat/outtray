import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_DIRECTORY_MODE,
  appDataDir,
  defaultDatabasePath,
  ensureAppDataDir,
  UnsupportedPlatformError,
} from './app-paths.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'outtray-paths-'));
  dirs.push(dir);
  return dir;
}

describe('appDataDir', () => {
  it('is Application Support on macOS, outside iCloud Documents sync scope', () => {
    expect(appDataDir({ platform: 'darwin', home: '/Users/x' })).toBe(
      '/Users/x/Library/Application Support/outtray',
    );
  });

  it('refuses a platform ADR-0011 has not decided about', () => {
    expect(() => appDataDir({ platform: 'linux', home: '/home/x' })).toThrow(
      UnsupportedPlatformError,
    );
    expect(() => appDataDir({ platform: 'win32', home: 'C:\\Users\\x' })).toThrow(
      UnsupportedPlatformError,
    );
  });
});

describe('defaultDatabasePath', () => {
  it('is one file inside the app directory', () => {
    expect(defaultDatabasePath({ platform: 'darwin', home: '/Users/x' })).toBe(
      '/Users/x/Library/Application Support/outtray/outtray.db',
    );
  });
});

describe('ensureAppDataDir', () => {
  it('creates the directory owner-only', async () => {
    const dir = join(await workspace(), 'a', 'b');
    expect(await ensureAppDataDir(dir)).toBe(dir);
    expect((await stat(dir)).mode & 0o777).toBe(APP_DIRECTORY_MODE);
  });

  it('tightens a directory that already exists too permissively', async () => {
    const dir = join(await workspace(), 'loose');
    await ensureAppDataDir(dir);
    await chmod(dir, 0o755);
    await ensureAppDataDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(APP_DIRECTORY_MODE);
  });

  it('rejects a path that is a file', async () => {
    const path = join(await workspace(), 'not-a-dir');
    await writeFile(path, 'x');
    await expect(ensureAppDataDir(path)).rejects.toThrow();
  });
});
