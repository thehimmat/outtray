import { describe, expect, it, vi } from 'vitest';
import type { GenerateRequest } from './model-provider.js';
import { NonLoopbackHostError, OllamaProvider } from './ollama-provider.js';

const enc = new TextEncoder();

interface MockInit {
  ok?: boolean;
  status?: number;
  text?: string;
  /** If set, split every emitted line into byte chunks of this size to exercise buffering. */
  chunkSize?: number;
}

/** Build a fetch-Response-like object whose `body` yields NDJSON like Ollama's stream. */
function mockResponse(lines: unknown[], init: MockInit = {}) {
  const ok = init.ok ?? true;
  const payload = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
  const bytes = enc.encode(payload);
  const size = init.chunkSize ?? bytes.length;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    text: async () => init.text ?? '',
    body: (async function* () {
      for (let i = 0; i < bytes.length; i += size) {
        yield bytes.subarray(i, i + size);
      }
    })(),
  };
}

const BILL_JSON = {
  type: 'bill',
  summary: '$301.00',
  action_items: [{ text: 'Pay by Aug 31', due_date: '2026-08-31' }],
  payee: 'STATE DMV',
  amount_due: '$301.00',
  due_date: '2026-08-31',
  late_fee: '$54.00',
};

const DONE = {
  done: true,
  done_reason: 'stop',
  total_duration: 3_000_000_000,
  load_duration: 150_000_000,
  prompt_eval_count: 1133,
  prompt_eval_duration: 600_000_000,
  eval_count: 129,
  eval_duration: 2_600_000_000,
};

/** Qwen3-VL with think:false: the constrained JSON still lands in `thinking` (issue #19). */
function thinkingChannelStream(json = JSON.stringify(BILL_JSON)) {
  const mid = Math.floor(json.length / 2);
  return [
    { message: { role: 'assistant', content: '', thinking: json.slice(0, mid) } },
    { message: { role: 'assistant', content: '', thinking: json.slice(mid) } },
    { message: { role: 'assistant', content: '', thinking: '' }, ...DONE },
  ];
}

function fetchReturning(res: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => res as Response);
}

describe('OllamaProvider', () => {
  it('extracts JSON from the thinking channel when content is empty (issue #19)', async () => {
    const fetch = fetchReturning(mockResponse(thinkingChannelStream(), { chunkSize: 7 }));
    const provider = new OllamaProvider({ fetch });
    const result = await provider.generate({ model: 'qwen3-vl:2b', prompt: 'x', format: {} });

    expect(result.jsonChannel).toBe('thinking');
    expect(result.json).toEqual(BILL_JSON);
  });

  it('prefers the content channel when the model puts JSON there', async () => {
    const stream = [
      { message: { content: JSON.stringify(BILL_JSON), thinking: 'noise not json' } },
      { message: { content: '', thinking: '' }, ...DONE },
    ];
    const provider = new OllamaProvider({ fetch: fetchReturning(mockResponse(stream)) });
    const result = await provider.generate({ model: 'qwen3-vl:2b', prompt: 'x', format: {} });

    expect(result.jsonChannel).toBe('content');
    expect(result.json).toEqual(BILL_JSON);
  });

  it('sends think:false, stream:true, the format schema, and images', async () => {
    const fetch = fetchReturning(mockResponse(thinkingChannelStream()));
    const provider = new OllamaProvider({ fetch });
    const req: GenerateRequest = {
      model: 'qwen3-vl:2b',
      prompt: 'classify this',
      images: ['BASE64IMG'],
      format: { type: 'object' },
    };
    await provider.generate(req);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(options.body as string);
    expect(body.think).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.format).toEqual({ type: 'object' });
    expect(body.messages[0].images).toEqual(['BASE64IMG']);
    expect(body.model).toBe('qwen3-vl:2b');
  });

  it('defaults the model to qwen3-vl:2b (the Phase 1 local default)', async () => {
    const fetch = fetchReturning(mockResponse(thinkingChannelStream()));
    const provider = new OllamaProvider({ fetch });
    await provider.generate({ prompt: 'x', format: {} });
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen3-vl:2b');
  });

  it('reports throughput from Ollama timing counters', async () => {
    const provider = new OllamaProvider({
      fetch: fetchReturning(mockResponse(thinkingChannelStream())),
    });
    const result = await provider.generate({ prompt: 'x', format: {} });
    expect(result.usage.genTokens).toBe(129);
    expect(result.usage.genTokPerSec).toBeCloseTo(49.6, 1);
    expect(result.doneReason).toBe('stop');
  });

  it('returns null json and channel when output is not valid JSON', async () => {
    const stream = [{ message: { content: 'not json', thinking: '' } }, { message: {}, ...DONE }];
    const provider = new OllamaProvider({ fetch: fetchReturning(mockResponse(stream)) });
    const result = await provider.generate({ prompt: 'x', format: {} });
    expect(result.json).toBeNull();
    expect(result.jsonChannel).toBeNull();
  });

  it('rejects a non-loopback host at construction (threat model)', () => {
    expect(() => new OllamaProvider({ host: 'http://example.com:11434' })).toThrow(
      NonLoopbackHostError,
    );
    expect(() => new OllamaProvider({ host: 'http://127.0.0.1:11434' })).not.toThrow();
    expect(() => new OllamaProvider({ host: 'http://localhost:11434' })).not.toThrow();
  });

  it('surfaces a non-2xx response as an error', async () => {
    const fetch = fetchReturning(mockResponse([], { ok: false, status: 500, text: 'boom' }));
    const provider = new OllamaProvider({ fetch });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/500/);
  });
});
