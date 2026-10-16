import { describe, expect, it } from 'vitest';
import {
  OCR_CONTRACT,
  OcrContractError,
  type OcrResult,
  ocrPlainText,
  parseOcrOutput,
} from './ocr-contract.js';

const line = (text: string, y: number) => ({
  text,
  confidence: 1,
  box: { x: 0.1, y, width: 0.5, height: 0.02 },
});

const valid: OcrResult = {
  contract: OCR_CONTRACT,
  engine: 'vision-recognize-text',
  engineRevision: 3,
  elapsedMs: 412.5,
  pages: [
    { width: 1632, height: 2000, lines: [line('Metro Electric', 0.05), line('$91.00', 0.4)] },
  ],
};

describe('parseOcrOutput', () => {
  it('accepts the sidecar output and returns it typed', () => {
    expect(parseOcrOutput(JSON.stringify(valid))).toEqual(valid);
  });

  it('rejects output that is not JSON, quoting the start of it', () => {
    expect(() => parseOcrOutput('dyld: Library not loaded')).toThrow(OcrContractError);
    expect(() => parseOcrOutput('dyld: Library not loaded')).toThrow(/dyld: Library/);
  });

  it('rejects another contract version by name, so a stale sidecar is obvious', () => {
    const stale = { ...valid, contract: 'ocr-v0' };
    expect(() => parseOcrOutput(JSON.stringify(stale))).toThrow(/ocr-v0.*ocr-v1/);
  });

  it('rejects a box outside the unit square', () => {
    const bad = {
      ...valid,
      pages: [
        {
          ...valid.pages[0],
          lines: [{ ...line('x', 0.1), box: { x: 0, y: 1.2, width: 0.1, height: 0.1 } }],
        },
      ],
    };
    expect(() => parseOcrOutput(JSON.stringify(bad))).toThrow(OcrContractError);
  });

  it('rejects a confidence outside 0..1', () => {
    const bad = {
      ...valid,
      pages: [{ ...valid.pages[0], lines: [{ ...line('x', 0.1), confidence: 1.5 }] }],
    };
    expect(() => parseOcrOutput(JSON.stringify(bad))).toThrow(OcrContractError);
  });

  it('rejects unknown keys, so a contract change has to bump the version', () => {
    expect(() => parseOcrOutput(JSON.stringify({ ...valid, language: 'en' }))).toThrow(
      OcrContractError,
    );
  });

  it('rejects an empty page list', () => {
    expect(() => parseOcrOutput(JSON.stringify({ ...valid, pages: [] }))).toThrow(OcrContractError);
  });

  it('accepts a page with no lines (a blank page is not an error)', () => {
    const blank = { ...valid, pages: [{ width: 10, height: 10, lines: [] }] };
    expect(parseOcrOutput(JSON.stringify(blank)).pages[0]?.lines).toEqual([]);
  });
});

describe('ocrPlainText', () => {
  it('joins lines in the order the sidecar gave them, one per line', () => {
    expect(ocrPlainText(valid)).toBe('Metro Electric\n$91.00');
  });

  it('separates pages with a blank line', () => {
    const two = {
      ...valid,
      pages: [valid.pages[0], { width: 1, height: 1, lines: [line('p2', 0)] }],
    };
    expect(ocrPlainText(two as OcrResult)).toBe('Metro Electric\n$91.00\n\np2');
  });
});
