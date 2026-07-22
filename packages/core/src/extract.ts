/**
 * Compose a `ModelProvider` and the extraction contract into one validated
 * extraction (the core of the Phase 1 walking skeleton).
 *
 * `extract` sends the document images plus the versioned extraction prompt and
 * the contract's JSON Schema as the constrained-decoding `format`, then
 * validates whatever comes back against the same Zod schema. The provider is
 * injected, so this is pure domain logic (ADR-0001) and testable without a
 * model.
 */

import {
  type DocumentExtraction,
  documentJsonSchema,
  validateExtraction,
} from './extraction-schema.js';
import type { GenerateUsage, ModelProvider } from './model-provider.js';

/**
 * Prompt template version. Part of the record/replay cache key (METHODOLOGY.md),
 * so bump it whenever the prompt text below changes.
 */
export const PROMPT_VERSION = 'extract-v1';

export const EXTRACTION_PROMPT = [
  'You are a document triage assistant. Classify this document into exactly one',
  'type (letter, bill, receipt, id_document, contract, policy, statement, or',
  'unknown) and extract its fields. Use `unknown` only when no other type fits.',
  'Put every deadline, payment, or required action into action_items, each with',
  'its due_date in ISO 8601 (YYYY-MM-DD) or null if none is stated.',
  'Respond only with JSON matching the schema.',
].join(' ');

/** Input to one extraction: the document's page images and an optional model override. */
export interface ExtractInput {
  /** Page images as base64 strings (no `data:` prefix). */
  images: string[];
  /** Model tag override; defaults to the provider's default (`qwen3-vl:2b`). */
  model?: string;
}

/** The outcome of one extraction. */
export interface ExtractResult {
  /** The validated document, or null when extraction failed validation. */
  document: DocumentExtraction | null;
  /** Whether the model output parsed and matched the contract. */
  valid: boolean;
  /** Which channel the JSON came from (`thinking` for Qwen3-VL; see issue #19). */
  jsonChannel: 'content' | 'thinking' | null;
  /** The raw parsed JSON before validation, for debugging failed extractions. */
  raw: unknown;
  /** Timing and token counts from the provider. */
  usage: GenerateUsage;
  /** A human-readable reason when `valid` is false, else null. */
  error: string | null;
}

/**
 * Run one document through a provider and validate the result.
 *
 * Failure modes: rejects only if the provider itself rejects (e.g. the runtime
 * is unreachable). A model that returns no JSON or off-contract JSON is not an
 * exception: it resolves with `valid: false`, `document: null`, and a populated
 * `error`, so the caller can route it to human review (ADR-0008).
 */
export async function extract(
  provider: ModelProvider,
  input: ExtractInput,
): Promise<ExtractResult> {
  const res = await provider.generate({
    prompt: EXTRACTION_PROMPT,
    images: input.images,
    format: documentJsonSchema,
    ...(input.model ? { model: input.model } : {}),
  });

  if (res.json === null) {
    return {
      document: null,
      valid: false,
      jsonChannel: res.jsonChannel,
      raw: null,
      usage: res.usage,
      error: 'no JSON parsed from model output',
    };
  }

  const parsed = validateExtraction(res.json);
  if (!parsed.success) {
    return {
      document: null,
      valid: false,
      jsonChannel: res.jsonChannel,
      raw: res.json,
      usage: res.usage,
      error: parsed.error.message,
    };
  }

  return {
    document: parsed.data,
    valid: true,
    jsonChannel: res.jsonChannel,
    raw: res.json,
    usage: res.usage,
    error: null,
  };
}
