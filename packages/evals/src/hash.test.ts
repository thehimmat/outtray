import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('matches the well-known digest of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the well-known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes strings as UTF-8, identical to the equivalent bytes', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex(new TextEncoder().encode('abc')));
  });
});
