import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, readSettings, writeSettings } from './settings.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'outtray-settings-'));
  path = join(dir, 'outtray', 'config.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readSettings', () => {
  it('defaults to identifier storage off when there is no config file', async () => {
    expect(DEFAULT_SETTINGS.identifierStorage).toBe(false);
    expect(await readSettings(path)).toEqual({ settings: DEFAULT_SETTINGS, warning: null });
  });

  it('reads back what was written', async () => {
    await writeSettings(path, { identifierStorage: true });
    expect(await readSettings(path)).toEqual({
      settings: { identifierStorage: true, ocr: false },
      warning: null,
    });
  });

  it('falls back to off with a warning for a file that is not JSON', async () => {
    await writeSettings(path, DEFAULT_SETTINGS);
    await writeFile(path, '{ identifierStorage: true');
    const { settings, warning } = await readSettings(path);
    expect(settings.identifierStorage).toBe(false);
    expect(warning).toMatch(/config\.json/);
  });

  it('only a literal true turns identifier storage on', async () => {
    await writeSettings(path, DEFAULT_SETTINGS);
    await writeFile(path, JSON.stringify({ identifierStorage: 'yes' }));
    const { settings, warning } = await readSettings(path);
    expect(settings.identifierStorage).toBe(false);
    expect(warning).toMatch(/identifierStorage/);
  });

  it('treats a missing key as off without a warning', async () => {
    await writeSettings(path, DEFAULT_SETTINGS);
    await writeFile(path, '{}');
    expect(await readSettings(path)).toEqual({ settings: DEFAULT_SETTINGS, warning: null });
  });
});

describe('the ocr setting (ADR-0009 amendment 3)', () => {
  it('is off by default and reads back what was written', async () => {
    expect(DEFAULT_SETTINGS.ocr).toBe(false);
    await writeSettings(path, { ocr: true });
    expect((await readSettings(path)).settings).toEqual({ identifierStorage: false, ocr: true });
  });

  it('warns about a bad ocr value without resetting identifier storage', async () => {
    await writeSettings(path, DEFAULT_SETTINGS);
    await writeFile(path, JSON.stringify({ identifierStorage: true, ocr: 'on' }));
    const { settings, warning } = await readSettings(path);
    expect(settings).toEqual({ identifierStorage: true, ocr: false });
    expect(warning).toMatch(/ocr in .*config\.json/);
  });
});

describe('writeSettings', () => {
  it('changes only the keys it is given, keeping the others and any it does not know', async () => {
    await writeSettings(path, DEFAULT_SETTINGS);
    await writeFile(path, JSON.stringify({ identifierStorage: true, later: 1 }));
    await writeSettings(path, { ocr: true });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      identifierStorage: true,
      later: 1,
      ocr: true,
    });
  });

  it('starts afresh over a file that is not a JSON object', async () => {
    await writeSettings(path, DEFAULT_SETTINGS);
    await writeFile(path, 'not json');
    await writeSettings(path, { ocr: true });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ocr: true });
  });

  it('creates the data directory owner-only and the file owner-readable', async () => {
    await writeSettings(path, { identifierStorage: true });
    expect((await stat(join(dir, 'outtray'))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('replaces the file whole, leaving no temporary file behind', async () => {
    await writeSettings(path, { identifierStorage: true });
    await writeSettings(path, { identifierStorage: false });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ identifierStorage: false });
    expect(await readdir(join(dir, 'outtray'))).toEqual(['config.json']);
  });
});
