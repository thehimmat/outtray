/**
 * Text embeddings for retrieval (ADR-0005).
 *
 * A seam like `ModelProvider`, so the concrete embedding backend is swappable
 * and retrieval code never depends on one. `OllamaEmbeddingProvider` calls
 * Ollama's `/api/embed` with a tiny embedding model (100-600 MB class per
 * ADR-0002/0005). The model is passed in explicitly rather than defaulted here:
 * which embedding model to ship is a measurement-driven decision for a later
 * ADR, the way ADR-0002 chose the VLM.
 */

import { assertLoopback } from './loopback.js';

/** A swappable text-embedding backend. */
export interface EmbeddingProvider {
  /** Stable identifier for logs and the scoreboard. */
  readonly name: string;
  /**
   * Embed a batch of texts into vectors, one per input in order.
   *
   * Failure modes: rejects if the backend is unreachable, returns a non-2xx
   * response, or returns a different number of vectors than inputs. Returns an
   * empty array for empty input without a network call.
   */
  embed(texts: string[]): Promise<number[][]>;
}

export interface OllamaEmbeddingProviderOptions {
  /** Embedding model tag, e.g. `nomic-embed-text`. Required; no shipped default yet. */
  model: string;
  /** Base URL of the Ollama server. Must be loopback. Defaults to `http://127.0.0.1:11434`. */
  host?: string;
  /** Injected fetch (for tests). Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_HOST = 'http://127.0.0.1:11434';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama-embed';
  readonly #host: string;
  readonly #model: string;
  readonly #fetch: typeof globalThis.fetch;

  /** Failure modes: throws `NonLoopbackHostError` if `host` is not loopback. */
  constructor(options: OllamaEmbeddingProviderOptions) {
    this.#host = options.host ?? DEFAULT_HOST;
    assertLoopback(this.#host);
    this.#model = options.model;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await this.#fetch(`${this.#host}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.#model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/embed failed: ${res.status}`);
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    const embeddings = data.embeddings ?? [];
    if (embeddings.length !== texts.length) {
      throw new Error(
        `Ollama /api/embed returned ${embeddings.length} embeddings for ${texts.length} inputs (count mismatch)`,
      );
    }
    return embeddings;
  }
}
