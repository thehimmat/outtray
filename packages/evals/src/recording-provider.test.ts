import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateRequest, GenerateResult, ModelProvider } from '@outtray/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contractKey } from './contract.js';
import { RecordingProvider, StaleRecordingError } from './recording-provider.js';

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };

class CountingProvider implements ModelProvider {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly result: GenerateResult) {}
  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;
    return this.result;
  }
}

const req: GenerateRequest = {
  model: 'qwen3-vl:2b',
  prompt: 'p',
  images: ['IMG'],
  format: { type: 'object' },
  options: { temperature: 0 },
};

const result: GenerateResult = {
  json: { type: 'unknown', summary: 's', action_items: [] },
  jsonChannel: 'thinking',
  content: '',
  thinking: '{}',
  doneReason: 'stop',
  usage,
};

describe('RecordingProvider', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'outtray-rec-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records a real call, then replays it without the inner provider', async () => {
    const inner = new CountingProvider(result);
    const recorder = new RecordingProvider({ inner, dir, mode: 'record' });
    const recorded = await recorder.generate(req);
    expect(recorded).toEqual(result);
    expect(inner.calls).toBe(1);

    // A replay-mode provider with no inner returns the stored result and never calls a model.
    const replayer = new RecordingProvider({ dir, mode: 'replay' });
    const replayed = await replayer.generate(req);
    expect(replayed).toEqual(result);
    expect(inner.calls).toBe(1); // unchanged
  });

  it('writes the recording under the contract key', async () => {
    const recorder = new RecordingProvider({
      inner: new CountingProvider(result),
      dir,
      mode: 'record',
    });
    await recorder.generate(req);
    const files = await readdir(dir);
    expect(files).toContain(`${contractKey(req)}.json`);
  });

  it('throws StaleRecordingError on a replay miss', async () => {
    const replayer = new RecordingProvider({ dir, mode: 'replay' });
    await expect(replayer.generate(req)).rejects.toBeInstanceOf(StaleRecordingError);
  });

  it('replay miss names the fix in its message', async () => {
    const replayer = new RecordingProvider({ dir, mode: 'replay' });
    await expect(replayer.generate(req)).rejects.toThrow(/eval:record/);
  });

  it('record-missing replays an existing recording without touching the inner provider', async () => {
    await new RecordingProvider({
      inner: new CountingProvider(result),
      dir,
      mode: 'record',
    }).generate(req);

    const inner = new CountingProvider(result);
    const provider = new RecordingProvider({ inner, dir, mode: 'record-missing' });
    expect(await provider.generate(req)).toEqual(result);
    expect(inner.calls).toBe(0);
  });

  it('record-missing records a miss via the inner provider, then replays it', async () => {
    const inner = new CountingProvider(result);
    const provider = new RecordingProvider({ inner, dir, mode: 'record-missing' });
    expect(await provider.generate(req)).toEqual(result);
    expect(inner.calls).toBe(1);
    expect(await readdir(dir)).toContain(`${contractKey(req)}.json`);
    expect(await provider.generate(req)).toEqual(result);
    expect(inner.calls).toBe(1); // second call replayed
  });

  it('record mode requires an inner provider', async () => {
    const recorder = new RecordingProvider({ dir, mode: 'record' });
    await expect(recorder.generate(req)).rejects.toThrow(/inner provider/);
  });

  it('a changed prompt does not replay the old recording (stale)', async () => {
    await new RecordingProvider({
      inner: new CountingProvider(result),
      dir,
      mode: 'record',
    }).generate(req);
    const replayer = new RecordingProvider({ dir, mode: 'replay' });
    await expect(replayer.generate({ ...req, prompt: 'changed' })).rejects.toBeInstanceOf(
      StaleRecordingError,
    );
  });
});
