import { describe, expect, it } from 'vitest';
import { extract } from './extract.js';
import type { GenerateRequest, GenerateResult, ModelProvider } from './model-provider.js';

const usage = {
  loadMs: 0,
  promptTokens: 1133,
  genTokens: 129,
  genTokPerSec: 49.6,
  totalMs: 3000,
};

const BILL = {
  type: 'bill',
  summary: 'DMV renewal.',
  action_items: [{ text: 'Pay $301 by Aug 31', due_date: '2026-08-31' }],
  payee: 'State DMV',
  amount_due: '$301.00',
  due_date: '2026-08-31',
  late_fee: '$54.00',
};

/** A ModelProvider that returns a canned result and records the request it got. */
class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  lastRequest: GenerateRequest | undefined;
  constructor(private readonly result: GenerateResult) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.lastRequest = req;
    return this.result;
  }
}

function resultWith(json: unknown, jsonChannel: GenerateResult['jsonChannel']): GenerateResult {
  return { json, jsonChannel, content: '', thinking: '', doneReason: 'stop', usage };
}

describe('extract', () => {
  it('validates the model JSON and returns a typed document', async () => {
    const provider = new FakeProvider(resultWith(BILL, 'thinking'));
    const out = await extract(provider, { images: ['IMG'] });

    expect(out.valid).toBe(true);
    expect(out.document?.type).toBe('bill');
    expect(out.error).toBeNull();
    expect(out.jsonChannel).toBe('thinking');
  });

  it('passes the JSON-schema format and the images through to the provider', async () => {
    const provider = new FakeProvider(resultWith(BILL, 'content'));
    await extract(provider, { images: ['IMG1', 'IMG2'], model: 'qwen3-vl:2b' });

    expect(provider.lastRequest?.format).toBeDefined();
    expect(provider.lastRequest?.images).toEqual(['IMG1', 'IMG2']);
    expect(provider.lastRequest?.model).toBe('qwen3-vl:2b');
  });

  it('reports invalid when the model returns no JSON', async () => {
    const provider = new FakeProvider(resultWith(null, null));
    const out = await extract(provider, { images: ['IMG'] });
    expect(out.valid).toBe(false);
    expect(out.document).toBeNull();
    expect(out.error).toMatch(/no JSON/i);
  });

  it('reports invalid when the JSON does not match the contract', async () => {
    const provider = new FakeProvider(resultWith({ type: 'bill', summary: 'x' }, 'content'));
    const out = await extract(provider, { images: ['IMG'] });
    expect(out.valid).toBe(false);
    expect(out.document).toBeNull();
    expect(out.error).toBeTruthy();
  });
});
