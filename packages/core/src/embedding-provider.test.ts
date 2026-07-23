import { describe, expect, it, vi } from 'vitest';
import { OllamaEmbeddingProvider } from './embedding-provider.js';
import { NonLoopbackHostError } from './ollama-provider.js';

function fetchReturning(res: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => res as Response);
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('OllamaEmbeddingProvider', () => {
  it('embeds a batch of texts via /api/embed', async () => {
    const fetch = fetchReturning(
      jsonResponse({
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }),
    );
    const provider = new OllamaEmbeddingProvider({ fetch, model: 'nomic-embed-text' });
    const vectors = await provider.embed(['alpha', 'beta']);

    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/embed');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('nomic-embed-text');
    expect(body.input).toEqual(['alpha', 'beta']);
  });

  it('returns an empty array without calling the server for no input', async () => {
    const fetch = fetchReturning(jsonResponse({ embeddings: [] }));
    const provider = new OllamaEmbeddingProvider({ fetch, model: 'nomic-embed-text' });
    expect(await provider.embed([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback host (threat model)', () => {
    expect(() => new OllamaEmbeddingProvider({ host: 'http://example.com', model: 'x' })).toThrow(
      NonLoopbackHostError,
    );
  });

  it('surfaces a non-2xx response as an error', async () => {
    const provider = new OllamaEmbeddingProvider({
      fetch: fetchReturning(jsonResponse({ error: 'nope' }, { ok: false, status: 500 })),
      model: 'nomic-embed-text',
    });
    await expect(provider.embed(['x'])).rejects.toThrow(/500/);
  });

  it('errors if the server returns the wrong number of embeddings', async () => {
    const provider = new OllamaEmbeddingProvider({
      fetch: fetchReturning(jsonResponse({ embeddings: [[0.1]] })),
      model: 'nomic-embed-text',
    });
    await expect(provider.embed(['a', 'b'])).rejects.toThrow(/count/i);
  });
});
