import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentHashOf, toBase64 } from './bytes.js';
import { extensionOf } from './document-source.js';

describe('contentHashOf', () => {
  it('is the hex SHA-256 of the bytes, the key scan stores documents under', async () => {
    const bytes = Buffer.from('some bytes');
    expect(await contentHashOf(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('toBase64', () => {
  it('matches Buffer base64, including inputs past one encoding chunk', () => {
    const big = new Uint8Array(100_000).map((_, i) => (i * 37) % 256);
    for (const bytes of [new Uint8Array(), Buffer.from('hi'), big]) {
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('extensionOf', () => {
  it.each([
    ['a.PNG', '.png'],
    ['dir/b.jpeg', '.jpeg'],
    ['noext', ''],
    ['.hidden', ''],
    ['archive.tar.gz', '.gz'],
  ])('%s has extension %s', (name, ext) => {
    expect(extensionOf(name)).toBe(ext);
  });
});
