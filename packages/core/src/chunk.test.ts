import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('returns nothing for empty or whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n ')).toEqual([]);
  });

  it('returns a single chunk for text under the limit', () => {
    const chunks = chunkText('A short document.', { maxChars: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ text: 'A short document.', index: 0 });
  });

  it('splits long text into sequential chunks under the limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => `sentence number ${i}.`).join(' ');
    const chunks = chunkText(text, { maxChars: 120, overlapChars: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.text.length).toBeLessThanOrEqual(120);
      expect(c.text.length).toBeGreaterThan(0);
    });
  });

  it('overlaps consecutive chunks so context is not lost at the seam', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(text, { maxChars: 60, overlapChars: 20 });
    // The last word of chunk 0 should reappear inside chunk 1 (overlap carried).
    const tail = chunks[0]?.text.split(' ').at(-1) ?? '';
    expect(chunks[1]?.text.includes(tail)).toBe(true);
  });

  it('breaks at a whitespace boundary rather than mid-word', () => {
    const text = `${'x'.repeat(40)} ${'y'.repeat(40)} ${'z'.repeat(40)}`;
    const chunks = chunkText(text, { maxChars: 90, overlapChars: 0 });
    for (const c of chunks) {
      expect(c.text).not.toMatch(/^x*y/); // no chunk starts mid-run across a broken word
    }
  });
});
