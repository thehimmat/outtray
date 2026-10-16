import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OCR_CONTRACT, type OcrResult } from '@outtray/core';
import { describe, expect, it } from 'vitest';
import { fixturesRoot, type ManifestEntry } from './fixtures/load.js';
import {
  findField,
  htmlVisibleText,
  loadOcrPages,
  OCR_VARIANTS,
  type OcrPage,
  ocrRecordingsDir,
  recordingPath,
  replayRecognizer,
  runOcrReport,
  scoreOcrFixture,
  summarizeByLevel,
  summarizeOcr,
  verifyDegradedManifest,
  wordRecall,
} from './ocr-eval.js';

function ocr(...lines: string[]): OcrResult {
  return {
    contract: OCR_CONTRACT,
    engine: 'vision-recognize-text',
    engineRevision: 3,
    elapsedMs: 100,
    pages: [
      {
        width: 1,
        height: 1,
        lines: lines.map((text, i) => ({
          text,
          confidence: 1,
          box: { x: 0, y: i / 100, width: 0.5, height: 0.01 },
        })),
      },
    ],
  };
}

describe('findField', () => {
  const text =
    'Metro Electric Statement\nPayment due date February 16, 2027\nTotal amount due $91.00';

  it('finds a text value case- and whitespace-insensitively, across a line break', () => {
    expect(findField('text', 'metro  electric', text)).toBe(true);
    expect(findField('text', 'Statement Payment', text)).toBe(true);
    expect(findField('text', 'Northside Grocers', text)).toBe(false);
  });

  it('finds an amount in any rendering of the same number', () => {
    expect(findField('amount', '$91.00', text)).toBe(true);
    expect(findField('amount', '91', text)).toBe(true);
    expect(findField('amount', '$56.00', text)).toBe(false);
  });

  it('does not take a bare number, such as part of a date, for an amount', () => {
    expect(findField('amount', '$16.00', text)).toBe(false);
    expect(findField('amount', '2027', text)).toBe(false);
  });

  it('matches text only on word boundaries', () => {
    expect(findField('text', 'A1234', 'License A12345')).toBe(false);
    expect(findField('text', 'Ann Lee', 'Joann Leeds')).toBe(false);
    expect(findField('text', 'Ann Lee', 'Dear Ann Lee,')).toBe(true);
  });

  it('finds an amount that ends a sentence', () => {
    expect(findField('amount', '$56.00', 'incur a late fee of $56.00. Do not mail cash.')).toBe(
      true,
    );
    expect(findField('amount', '1,250', 'a fee of $1,250, payable')).toBe(true);
  });

  it('finds an ISO-labelled date written out in words', () => {
    expect(findField('date', '2027-02-16', text)).toBe(true);
    expect(findField('date', '2027-02-17', text)).toBe(false);
  });

  it('finds numeric and day-first dates', () => {
    expect(findField('date', '2026-07-23', 'Expires 07/23/2026')).toBe(true);
    expect(findField('date', '2026-07-23', 'Expires 23 July 2026')).toBe(true);
  });

  it('does not find a date the OCR misread', () => {
    expect(findField('date', '2027-02-16', 'February 18, 2027')).toBe(false);
  });
});

describe('htmlVisibleText', () => {
  it('drops the style block and tags and decodes entities', () => {
    const html =
      '<html><head><style>p{color:red}</style></head><body><p>A &amp; B</p><td>$1.00</td></body></html>';
    expect(htmlVisibleText(html)).toBe('A & B $1.00');
  });

  it('drops the head, whose title is never rendered on the page', () => {
    const html = '<html><head><title>Bill</title></head><body>Reg 4 &middot; Trn 1</body></html>';
    expect(htmlVisibleText(html)).toBe('Reg 4 \u00b7 Trn 1');
  });
});

describe('wordRecall', () => {
  it('counts each truth word once per occurrence, ignoring case and edge punctuation', () => {
    expect(wordRecall('Due: $91.00. Due', 'due $91.00 due')).toEqual({ found: 3, total: 3 });
    expect(wordRecall('Due date due', 'due')).toEqual({ found: 1, total: 3 });
  });
});

describe('scoreOcrFixture', () => {
  it('scores every labelled field except type and the free-text summary', () => {
    const score = scoreOcrFixture(
      'policy-x',
      {
        type: 'policy',
        insurer: 'Harbor Casualty',
        policy_number: 'POL-804220',
        coverage_summary: 'Comprehensive auto',
        expiry_date: '2026-12-16',
      },
      '<p>Harbor Casualty</p><p>Policy POL-804220</p><p>Expires December 16, 2026</p>',
      ocr('Harbor Casualty', 'Policy POL-8O4220', 'Expires December 16, 2026'),
    );
    expect(score.fields).toEqual([
      { field: 'insurer', expected: 'Harbor Casualty', found: true },
      { field: 'policy_number', expected: 'POL-804220', found: false },
      { field: 'expiry_date', expected: '2026-12-16', found: true },
    ]);
    expect(score.words).toEqual({ found: 7, total: 8 });
    expect(score.lines).toBe(3);
    expect(score.elapsedMs).toBe(100);
  });
});

describe('identifiers are matched character for character', () => {
  const labels = { type: 'id_document' as const, id_number: 'C4821983' };
  const idFound = (line: string) =>
    scoreOcrFixture('x', labels, '', ocr(line)).fields.find((f) => f.field === 'id_number')?.found;

  it('finds the identifier as printed', () => {
    expect(idFound('License number C4821983')).toBe(true);
  });

  it('misses it in another case or with a space inside', () => {
    expect(idFound('License number c4821983')).toBe(false);
    expect(idFound('License number C482 1983')).toBe(false);
  });
});

describe('summarizeOcr', () => {
  it('totals field, identifier and word recall and takes the median time', () => {
    const a = {
      id: 'a',
      fields: [
        { field: 'x', expected: '1', found: true },
        { field: 'id_number', expected: 'D1', found: false },
      ],
      words: { found: 9, total: 10 },
      lines: 4,
      minConfidence: 0.5,
      elapsedMs: 100,
    };
    const b = {
      ...a,
      id: 'b',
      fields: [{ field: 'policy_number', expected: 'P1', found: true }],
      elapsedMs: 300,
    };
    const c = { ...a, id: 'c', fields: [], elapsedMs: 200 };
    expect(summarizeOcr([a, b, c])).toEqual({
      fixtures: 3,
      fieldsFound: 2,
      fieldsTotal: 3,
      wordsFound: 27,
      wordsTotal: 30,
      identifiersFound: 1,
      identifiersTotal: 2,
      medianMs: 200,
      misses: [{ id: 'a', field: 'id_number', expected: 'D1' }],
    });
  });
});

describe('summarizeByLevel', () => {
  it('summarizes each level that has rows, in level order', () => {
    const row = (id: string, level: 'clean' | 'harsh') => ({
      id,
      level,
      fields: [],
      words: { found: 1, total: 1 },
      lines: 1,
      minConfidence: 1,
      elapsedMs: 1,
    });
    const out = summarizeByLevel([row('a.harsh', 'harsh'), row('a', 'clean')]);
    expect(Object.keys(out)).toEqual(['clean', 'harsh']);
    expect(out.harsh?.fixtures).toBe(1);
  });
});

describe('loadOcrPages', () => {
  it('lists each clean fixture, then its degraded copies scored against the same labels', async () => {
    const pages = await loadOcrPages();
    expect(pages.filter((p) => p.level === 'clean')).toHaveLength(10);
    const harsh = pages.find((p) => p.id === 'bill-001.harsh');
    expect(harsh?.source.id).toBe('bill-001');
    expect(harsh?.imagePath).toBe('degraded/bill-001.harsh.jpg');
  });

  it('every degraded image matches its manifest checksum', async () => {
    expect(await verifyDegradedManifest()).toEqual([]);
  });
});

describe('replayRecognizer', () => {
  const page = {
    id: 'bill-001',
    level: 'clean',
    source: {} as ManifestEntry,
    imagePath: 'synthetic/bill-001.png',
    imageSha256: 'abc',
  } as OcrPage;

  async function dirWith(name: string, body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ocr-rec-'));
    await mkdir(join(dir, 'default'));
    await writeFile(join(dir, 'default', name), body);
    return dir;
  }

  it('returns the recorded result for an unchanged image', async () => {
    const result = ocr('Metro Electric');
    const dir = await dirWith(
      'bill-001.json',
      JSON.stringify({
        page: 'bill-001',
        variant: 'default',
        imageSha256: 'abc',
        host: 'x',
        result,
      }),
    );
    await expect(replayRecognizer('default', dir)(page, 'unused')).resolves.toEqual(result);
  });

  it('refuses a recording made from a different image', async () => {
    const dir = await dirWith(
      'bill-001.json',
      JSON.stringify({ page: 'bill-001', imageSha256: 'old', host: 'x', result: ocr('x') }),
    );
    await expect(replayRecognizer('default', dir)(page, 'unused')).rejects.toThrow(
      /different image/,
    );
  });

  it('reports a corrupt recording as corrupt, not missing', async () => {
    const dir = await dirWith('bill-001.json', '<<<<<<< HEAD\n{');
    await expect(replayRecognizer('default', dir)(page, 'unused')).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('names the variant, the missing page and how to record it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocr-rec-'));
    await expect(replayRecognizer('no-language-correction', dir)(page, 'unused')).rejects.toThrow(
      /no-language-correction.*bill-001.*record/,
    );
  });
});

describe('the committed OCR recordings and snapshot', () => {
  it('every page has a recording in every variant', async () => {
    const pages = await loadOcrPages();
    const missing: string[] = [];
    for (const variant of OCR_VARIANTS) {
      for (const p of pages) {
        try {
          await readFile(join(ocrRecordingsDir(), recordingPath(variant, p.id)));
        } catch {
          missing.push(`${variant}/${p.id}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('replaying them reproduces fixtures/ocr.json', async () => {
    const snapshot = JSON.parse(await readFile(join(fixturesRoot(), 'ocr.json'), 'utf8'));
    for (const variant of OCR_VARIANTS) {
      const { rows } = await runOcrReport(replayRecognizer(variant));
      expect(rows).toEqual(snapshot.variants[variant].rows);
      expect(summarizeByLevel(rows)).toEqual(snapshot.variants[variant].byLevel);
    }
  });
});
