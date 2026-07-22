import { createHash } from 'node:crypto';

/**
 * SHA-256 content hash, hex-encoded.
 *
 * This is the provenance primitive for the eval harness (see
 * docs/evals/METHODOLOGY.md): recordings are keyed by a hash of the full
 * model-input contract, the fixture manifest checksums fixture files, and the
 * scoreboard embeds fixture-set and prompt hashes so CI can detect staleness.
 *
 * Failure modes: none for string or Uint8Array input; deterministic across
 * platforms (input strings are hashed as UTF-8).
 */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
