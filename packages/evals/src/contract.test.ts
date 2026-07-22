import type { GenerateRequest } from '@outtray/core';
import { describe, expect, it } from 'vitest';
import { contractKey } from './contract.js';

const base: GenerateRequest = {
  model: 'qwen3-vl:2b',
  prompt: 'classify this',
  images: ['IMG'],
  format: { type: 'object' },
  options: { temperature: 0, numCtx: 4096 },
};

describe('contractKey', () => {
  it('is stable for the same contract', () => {
    expect(contractKey(base)).toBe(contractKey({ ...base }));
  });

  it('is a 64-char hex SHA-256', () => {
    expect(contractKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the prompt changes (a re-record is required)', () => {
    expect(contractKey({ ...base, prompt: 'different' })).not.toBe(contractKey(base));
  });

  it('changes when the images change', () => {
    expect(contractKey({ ...base, images: ['OTHER'] })).not.toBe(contractKey(base));
  });

  it('changes when the model changes', () => {
    expect(contractKey({ ...base, model: 'qwen3-vl:4b' })).not.toBe(contractKey(base));
  });

  it('changes when the schema (format) changes', () => {
    expect(contractKey({ ...base, format: { type: 'string' } })).not.toBe(contractKey(base));
  });

  it('changes when decoding options change', () => {
    expect(contractKey({ ...base, options: { temperature: 0.5 } })).not.toBe(contractKey(base));
  });

  it('is insensitive to key order within the schema', () => {
    const a = contractKey({ ...base, format: { type: 'object', title: 'x' } });
    const b = contractKey({ ...base, format: { title: 'x', type: 'object' } });
    expect(a).toBe(b);
  });
});
