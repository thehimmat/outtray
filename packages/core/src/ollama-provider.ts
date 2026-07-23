/**
 * Local inference via Ollama's HTTP API (ADR-0002, ADR-0003).
 *
 * The shipped default provider. Talks to Ollama's `/api/chat` over a streaming
 * NDJSON response, defaults to `qwen3-vl:2b` (the Phase 1 local default), and
 * handles the Qwen3-VL structured-output quirk: with `think:false` set, the
 * constrained JSON is still emitted into `message.thinking` rather than
 * `message.content` on Ollama 0.32.1, so this reads content first and falls
 * back to the thinking channel (issue #19).
 */

import { assertLoopback } from './loopback.js';
import type { GenerateRequest, GenerateResult, ModelProvider } from './model-provider.js';

// Re-exported for API stability; the guard now lives in loopback.ts, shared
// with the embedding provider.
export { NonLoopbackHostError } from './loopback.js';

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3-vl:2b';

export interface OllamaProviderOptions {
  /** Base URL of the Ollama server. Must be loopback. Defaults to `http://127.0.0.1:11434`. */
  host?: string;
  /** Injected fetch (for tests). Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Model tag used when a request omits one. Defaults to `qwen3-vl:2b`. */
  defaultModel?: string;
}

/** The `done: true` terminal chunk carries Ollama's timing counters (nanoseconds). */
interface OllamaTiming {
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaStreamChunk extends OllamaTiming {
  message?: { content?: string; thinking?: string };
  done?: boolean;
}

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  readonly #host: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #defaultModel: string;

  /**
   * Failure modes: throws `NonLoopbackHostError` if `host` is not a loopback
   * address. The endpoint is validated here, not per-request, so a misconfigured
   * provider fails fast at construction.
   */
  constructor(options: OllamaProviderOptions = {}) {
    this.#host = options.host ?? DEFAULT_HOST;
    assertLoopback(this.#host);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.#defaultModel,
      messages: [
        {
          role: 'user',
          content: req.prompt,
          ...(req.images ? { images: req.images } : {}),
        },
      ],
      // issue #19: Qwen3-VL is a reasoning model; keep the token budget on the
      // JSON answer, not on a <think> chain that would truncate the output.
      think: false,
      stream: true,
      options: {
        temperature: req.options?.temperature ?? 0,
        ...(req.options?.numCtx !== undefined ? { num_ctx: req.options.numCtx } : {}),
        ...(req.options?.numPredict !== undefined ? { num_predict: req.options.numPredict } : {}),
      },
      keep_alive: '5m',
    };
    if (req.format !== undefined) {
      body.format = req.format;
    }

    const res = await this.#fetch(`${this.#host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/chat failed: ${res.status} ${await safeText(res)}`.trim());
    }

    let content = '';
    let thinking = '';
    let timing: OllamaTiming = {};
    let buf = '';
    const decoder = new TextDecoder();
    const stream = res.body as unknown as AsyncIterable<Uint8Array> | null;
    if (stream) {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const parsed = JSON.parse(line) as OllamaStreamChunk;
          if (parsed.message?.content) content += parsed.message.content;
          if (parsed.message?.thinking) thinking += parsed.message.thinking;
          if (parsed.done) timing = parsed;
        }
      }
    }

    const { json, jsonChannel } = recoverJson(content, thinking);
    return {
      json,
      jsonChannel,
      content,
      thinking,
      doneReason: timing.done_reason,
      usage: {
        loadMs: nsToMs(timing.load_duration),
        promptTokens: timing.prompt_eval_count,
        genTokens: timing.eval_count,
        genTokPerSec: tokensPerSecond(timing.eval_count, timing.eval_duration),
        totalMs: nsToMs(timing.total_duration),
      },
    };
  }
}

/** Recover JSON from the content channel, falling back to thinking (issue #19). */
function recoverJson(
  content: string,
  thinking: string,
): { json: unknown | null; jsonChannel: 'content' | 'thinking' | null } {
  for (const [channel, text] of [
    ['content', content],
    ['thinking', thinking],
  ] as const) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    try {
      return { json: JSON.parse(trimmed), jsonChannel: channel };
    } catch {
      // Not JSON in this channel; try the next one.
    }
  }
  return { json: null, jsonChannel: null };
}

function nsToMs(ns: number | undefined): number {
  return ns ? Math.round(ns / 1e6) : 0;
}

function tokensPerSecond(
  tokens: number | undefined,
  durationNs: number | undefined,
): number | null {
  if (!tokens || !durationNs) return null;
  return tokens / (durationNs / 1e9);
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
