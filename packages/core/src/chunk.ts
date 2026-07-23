/**
 * Split document text into overlapping passages for retrieval (ADR-0005).
 *
 * A greedy character-window splitter that prefers to break at whitespace so
 * chunks do not cut words in half, with a configurable overlap so context is
 * not lost at the seam between adjacent chunks. Kept deliberately simple:
 * retrieval quality is measured later, and the chunker is a swappable knob.
 */

export interface ChunkOptions {
  /** Maximum characters per chunk. */
  maxChars?: number;
  /** Characters of overlap carried from the end of one chunk into the next. */
  overlapChars?: number;
}

/** One passage of a document, with its position in the chunk sequence. */
export interface Chunk {
  text: string;
  index: number;
}

/**
 * Chunk `text` into passages.
 *
 * Failure modes: none. Empty or whitespace-only input returns `[]`. When a run
 * has no whitespace to break on, it is split at the hard character limit.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? 500;
  const overlapChars = Math.min(options.overlapChars ?? 50, maxChars - 1);

  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean === '') return [];
  if (clean.length <= maxChars) return [{ text: clean, index: 0 }];

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const lastBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
      // Only honor the break if it is not so early that it makes a tiny chunk.
      if (lastBreak > maxChars * 0.5) end = start + lastBreak;
    }
    const piece = clean.slice(start, end).trim();
    if (piece !== '') {
      chunks.push({ text: piece, index });
      index += 1;
    }
    if (end >= clean.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}
