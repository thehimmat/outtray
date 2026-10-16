import { describe, expect, it } from 'vitest';
import { OCR_CONTRACT, type OcrResult } from './ocr-contract.js';
import { assessReadability, READABILITY_THRESHOLDS } from './ocr-readability.js';

/** A page of `n` lines of `text`, each `height` tall. */
function page(n: number, text: string, height: number) {
  return {
    width: 1000,
    height: 1000,
    lines: Array.from({ length: n }, (_, i) => ({
      text,
      confidence: 1,
      box: { x: 0.1, y: Math.min(0.9, i * 0.03), width: 0.5, height },
    })),
  };
}

function result(...pages: ReturnType<typeof page>[]): OcrResult {
  return {
    contract: OCR_CONTRACT,
    engine: 'vision-recognize-text',
    engineRevision: 3,
    elapsedMs: 1,
    pages,
  };
}

const body = 'Payments received after the due date'; // 36 characters

describe('assessReadability', () => {
  it('reads a page with plenty of body-sized text as readable', () => {
    const v = assessReadability(result(page(10, body, 0.015)));
    expect(v.readable).toBe(true);
    expect(v.pages[0]).toMatchObject({ readable: true, reasons: [], lines: 10, characters: 360 });
    expect(v.pages[0]?.medianLineHeight).toBeCloseTo(0.015);
  });

  it('flags a page where little text was found', () => {
    const v = assessReadability(result(page(2, 'Metro Electric', 0.015)));
    expect(v.readable).toBe(false);
    expect(v.pages[0]?.reasons).toEqual(['too-little-text']);
  });

  it('flags a page where only large text was found, however much of it', () => {
    const v = assessReadability(result(page(10, body, 0.03)));
    expect(v.readable).toBe(false);
    expect(v.pages[0]?.reasons).toEqual(['only-large-text']);
  });

  it('gives every reason that applies', () => {
    const v = assessReadability(result(page(2, 'Metro Electric', 0.04)));
    expect(v.pages[0]?.reasons).toEqual(['too-little-text', 'only-large-text']);
  });

  it('calls a page with no text unreadable, with its own reason', () => {
    const v = assessReadability(result(page(0, '', 0.015)));
    expect(v.readable).toBe(false);
    expect(v.pages[0]).toMatchObject({ reasons: ['no-text'], medianLineHeight: null });
  });

  it('is readable only when every page is', () => {
    const v = assessReadability(result(page(10, body, 0.015), page(2, 'Page 2', 0.015)));
    expect(v.readable).toBe(false);
    expect(v.pages.map((p) => p.readable)).toEqual([true, false]);
  });

  it('takes other thresholds', () => {
    const v = assessReadability(result(page(2, 'Metro Electric', 0.015)), {
      ...READABILITY_THRESHOLDS,
      minCharacters: 10,
    });
    expect(v.readable).toBe(true);
  });
});
