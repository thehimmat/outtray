/**
 * The single seam through which all inference flows (ADR-0003).
 *
 * Domain code depends on this interface, never on a concrete runtime, so the
 * local `OllamaProvider` and the eval-only cloud provider are interchangeable
 * and the shipped app can carry no cloud code path before Phase 5. Providers
 * are pure transport: prompt and optional page images in, one structured
 * response out. Classification, schema validation, and confidence scoring live
 * above this layer.
 */

/** Decoding knobs passed through to the runtime. All optional; providers default them. */
export interface GenerateOptions {
  /** Sampling temperature. Extraction runs at 0 for determinism. */
  temperature?: number;
  /** Context window in tokens. */
  numCtx?: number;
  /** Hard cap on generated tokens (-1 / omitted means the model default). */
  numPredict?: number;
}

/** One inference request: an instruction, optional page images, and an optional output schema. */
export interface GenerateRequest {
  /** Model tag, e.g. `qwen3-vl:2b`. Omitted means the provider's default model. */
  model?: string;
  /** The user/instruction text. */
  prompt: string;
  /** Page images as base64 strings (no `data:` prefix), for vision models. */
  images?: string[];
  /**
   * A JSON Schema for constrained decoding (typically `z.toJSONSchema(schema)`).
   * When set, the runtime is asked to emit JSON matching it. Shape is guaranteed
   * by the grammar; semantic validity is the caller's parse-time job (ADR-0004).
   */
  format?: unknown;
  /** Decoding options. */
  options?: GenerateOptions;
}

/** Throughput and latency, surfaced so the scoreboard and CLI can report real costs. */
export interface GenerateUsage {
  /** Model load time in milliseconds (0 when already resident). */
  loadMs: number;
  /** Prompt (input) token count, or undefined if the runtime did not report it. */
  promptTokens: number | undefined;
  /** Generated (output) token count, or undefined if not reported. */
  genTokens: number | undefined;
  /** Generation throughput in tokens/second, or null when it cannot be computed. */
  genTokPerSec: number | null;
  /** Total wall time for the call in milliseconds, as reported by the runtime. */
  totalMs: number;
}

/** The result of one `generate` call. */
export interface GenerateResult {
  /**
   * The parsed JSON output when a `format` was requested and the output parsed,
   * else null. Not schema-validated here; the caller validates against its Zod
   * schema (ADR-0004).
   */
  json: unknown | null;
  /**
   * Which channel the JSON was recovered from. Reasoning models on Ollama can
   * emit constrained JSON into `thinking` rather than `content` (issue #19), so
   * this records where it actually came from; null when no JSON was parsed.
   */
  jsonChannel: 'content' | 'thinking' | null;
  /** Raw text of the assistant content channel. */
  content: string;
  /** Raw text of the reasoning/thinking channel (empty for non-reasoning models). */
  thinking: string;
  /** Why generation stopped (`stop`, `length`, ...), or undefined if not reported. */
  doneReason: string | undefined;
  /** Timing and token counts. */
  usage: GenerateUsage;
}

/** A swappable inference backend (ADR-0003). */
export interface ModelProvider {
  /** Stable identifier for logs and the scoreboard, e.g. `ollama`. */
  readonly name: string;
  /**
   * Run one inference request.
   *
   * Failure modes: rejects if the backend is unreachable or returns a non-2xx
   * response. Does not reject on invalid model JSON; that surfaces as
   * `json: null` / `jsonChannel: null` for the caller to handle.
   */
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
