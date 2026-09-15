import { describe, expect, it } from 'vitest';
import {
  DATABASE_KEY_BYTES,
  DatabaseKeyError,
  generateDatabaseKey,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  KeychainKeyProvider,
  type SecurityResult,
  StaticKeyProvider,
} from './db-key.js';

const HEX = 'a'.repeat(DATABASE_KEY_BYTES * 2);

/** Record every `security` invocation and answer them from a script. */
function runner(answers: SecurityResult[]) {
  const calls: string[][] = [];
  const remaining = [...answers];
  const run = async (args: readonly string[]): Promise<SecurityResult> => {
    calls.push([...args]);
    return remaining.shift() ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const found = (hex: string): SecurityResult => ({ status: 0, stdout: `${hex}\n`, stderr: '' });
const notFound: SecurityResult = {
  status: 44,
  stdout: '',
  stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found.',
};

function provider(answers: SecurityResult[], overrides = {}) {
  const { run, calls } = runner(answers);
  return {
    calls,
    keys: new KeychainKeyProvider({
      run,
      platform: 'darwin',
      randomBytes: () => Buffer.alloc(DATABASE_KEY_BYTES, 0xab),
      ...overrides,
    }),
  };
}

describe('KeychainKeyProvider', () => {
  it('returns an existing key without creating one', async () => {
    const { keys, calls } = provider([found(HEX)]);
    const result = await keys.getOrCreateKey();
    expect(result.created).toBe(false);
    expect(result.key.toString('hex')).toBe(HEX);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
    ]);
  });

  it('generates and stores a key on first run, and says it did', async () => {
    const { keys, calls } = provider([notFound, { status: 0, stdout: '', stderr: '' }]);
    const result = await keys.getOrCreateKey();
    expect(result.created).toBe(true);
    expect(result.key).toHaveLength(DATABASE_KEY_BYTES);
    expect(calls[1]?.slice(0, 5)).toEqual([
      'add-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
    ]);
    expect(calls[1]).toContain(result.key.toString('hex'));
  });

  it('fails loudly when the Keychain refuses access, and never invents a key', async () => {
    const { keys, calls } = provider([
      { status: 128, stdout: '', stderr: 'security: User interaction is not allowed.' },
    ]);
    await expect(keys.getOrCreateKey()).rejects.toThrow(DatabaseKeyError);
    // One call only: it did not go on to store a replacement.
    expect(calls).toHaveLength(1);
  });

  it('refuses to replace a stored item that is not a key', async () => {
    // Overwriting it could strand a database that the real key still opens, so
    // this is a situation a person has to look at.
    const { keys, calls } = provider([found('not-a-key')]);
    const failure = keys.getOrCreateKey();
    await expect(failure).rejects.toThrow(DatabaseKeyError);
    await expect(failure).rejects.toThrow(/will not replace it/);
    expect(calls).toHaveLength(1);
  });

  it('refuses a key of the wrong length', async () => {
    const { keys } = provider([found('ab'.repeat(16))]);
    await expect(keys.getOrCreateKey()).rejects.toThrow(DatabaseKeyError);
  });

  it('fails when storing a new key fails', async () => {
    const { keys } = provider([notFound, { status: 45, stdout: '', stderr: 'write failed' }]);
    await expect(keys.getOrCreateKey()).rejects.toThrow(/write failed/);
  });

  it('refuses to run off macOS rather than picking a key store nobody chose', async () => {
    const { keys } = provider([found(HEX)], { platform: 'linux' });
    await expect(keys.getOrCreateKey()).rejects.toThrow(DatabaseKeyError);
  });
});

describe('StaticKeyProvider', () => {
  it('returns the key it was given, defaulting to not-just-created', async () => {
    const key = generateDatabaseKey();
    expect(await new StaticKeyProvider(key).getOrCreateKey()).toEqual({ key, created: false });
    expect((await new StaticKeyProvider(key, true).getOrCreateKey()).created).toBe(true);
  });

  it('copies the key so a caller cannot mutate it afterwards', async () => {
    const key = generateDatabaseKey();
    const keys = new StaticKeyProvider(key);
    key.fill(0);
    expect((await keys.getOrCreateKey()).key.equals(key)).toBe(false);
  });

  it('rejects a key that is not the real key length', () => {
    expect(() => new StaticKeyProvider(Buffer.alloc(16))).toThrow(DatabaseKeyError);
  });
});

describe('generateDatabaseKey', () => {
  it('produces 32 distinct random bytes', () => {
    const a = generateDatabaseKey();
    const b = generateDatabaseKey();
    expect(a).toHaveLength(DATABASE_KEY_BYTES);
    expect(a.equals(b)).toBe(false);
  });
});
