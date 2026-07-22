/**
 * The record/replay cache key (METHODOLOGY.md).
 *
 * Recordings are keyed by a SHA-256 of the full model-input contract so that
 * replay proves the committed recordings correspond to the current prompts,
 * schemas, model, and decoding params. Any change to those inputs changes the
 * key, and CI then fails with "stale recording, run pnpm eval:record" rather
 * than silently replaying an output that no longer matches the request.
 *
 * The methodology lists "prompt template version" and "schema version"; we hash
 * the actual prompt text and JSON Schema instead, which realizes the same
 * invariant without a version string that can be forgotten. The model *digest*
 * (as opposed to the tag) is not yet part of the key; see the tracking issue.
 */

import type { GenerateRequest } from '@outtray/core';
import { sha256Hex } from './hash.js';

/** Deterministic JSON with recursively sorted object keys, so key order never affects the hash. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Compute the recording key for a request.
 *
 * Failure modes: none; pure. Callers must set `model` explicitly for recorded
 * requests (the eval harness does), since an omitted model would otherwise key
 * differently from the concrete model that actually ran.
 */
export function contractKey(req: GenerateRequest): string {
  const contract = {
    model: req.model ?? '',
    prompt: sha256Hex(req.prompt),
    images: sha256Hex((req.images ?? []).join('\n')),
    format: sha256Hex(canonicalize(req.format ?? null)),
    options: canonicalize(req.options ?? {}),
  };
  return sha256Hex(canonicalize(contract));
}
