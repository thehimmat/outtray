import type { FindResult, ScanItem, ScanReport } from '@outtray/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatCitations, formatReport, run } from './main.js';

function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}
function captureStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run (arg handling)', () => {
  it('prints usage and exits 0 for --help and no args', async () => {
    const out = captureStdout();
    expect(await run(['--help'])).toBe(0);
    expect(await run([])).toBe(0);
    expect(out.mock.calls.join('')).toContain('Usage:');
  });

  it('prints the version and exits 0', async () => {
    const out = captureStdout();
    expect(await run(['--version'])).toBe(0);
    expect(out.mock.calls.join('')).toContain('0.0.0');
  });

  it('exits 1 on an unknown command', async () => {
    captureStdout();
    const err = captureStderr();
    expect(await run(['frobnicate'])).toBe(1);
    expect(err.mock.calls.join('')).toContain('Unknown command');
  });

  it('exits 1 when scan is given no directory (without touching the network)', async () => {
    const err = captureStderr();
    expect(await run(['scan'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/needs a directory/);
  });

  it('exits 1 when the scan directory does not exist', async () => {
    const err = captureStderr();
    expect(await run(['scan', '/no/such/outtray/dir'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/Cannot read directory/);
  });

  it('exits 1 when find is missing a directory or query (no network)', async () => {
    const err = captureStderr();
    expect(await run(['find'])).toBe(1);
    expect(await run(['find', '/some/dir'])).toBe(1); // dir but no query
    expect(err.mock.calls.join('')).toMatch(/usage: outtray find/);
  });

  it('exits 1 when the find directory does not exist', async () => {
    const err = captureStderr();
    expect(await run(['find', '/no/such/outtray/dir', 'butter'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/Cannot read directory/);
  });
});

describe('formatReport', () => {
  const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };

  const billDoc = {
    type: 'bill' as const,
    summary: 'DMV renewal, $301 due Aug 31.',
    action_items: [{ text: 'Pay $301.00', due_date: '2026-08-31' }],
    payee: 'State DMV',
    amount_due: '$301.00',
    due_date: '2026-08-31',
    late_fee: '$54.00',
  };

  function billItem(reconciliation: ScanItem['reconciliation']): ScanItem {
    return {
      file: 'renewal.png',
      result: {
        valid: true,
        jsonChannel: 'thinking',
        raw: {},
        usage,
        error: null,
        document: billDoc,
      },
      reconciliation,
    };
  }

  const unclassified: ScanItem['reconciliation'] = {
    effectiveType: 'bill',
    status: 'unclassified',
    review: false,
    vlmType: 'bill',
    classification: null,
  };

  it('renders type, summary, actions, and the skipped list', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: ['notes.txt'],
      items: [billItem(unclassified)],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill]');
    expect(text).toContain('DMV renewal');
    expect(text).toContain('- Pay $301.00 (due 2026-08-31)');
    expect(text).toContain('Skipped: notes.txt');
    expect(text).not.toContain('Review:');
  });

  it('renders a confirmed type with its confidence and the review tally', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: [],
      items: [
        billItem({
          effectiveType: 'bill',
          status: 'confirmed',
          review: false,
          vlmType: 'bill',
          classification: { type: 'bill', confidence: 0.69, votes: { bill: 1.2 } },
        }),
      ],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill, confirmed 0.69]');
    expect(text).toContain('Review: 0 of 1 item(s) flagged.');
  });

  it('renders a corrected type with its provenance', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: [],
      items: [
        billItem({
          effectiveType: 'bill',
          status: 'corrected',
          review: false,
          vlmType: 'statement',
          classification: { type: 'bill', confidence: 0.68, votes: { bill: 1.3 } },
        }),
      ],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill, corrected from statement 0.68]');
    expect(text).toContain('Review: 0 of 1 item(s) flagged.');
  });

  it('renders a disputed type as needing review', () => {
    const report: ScanReport = {
      scanned: ['stmt.png'],
      skipped: [],
      items: [
        {
          ...billItem({
            effectiveType: 'statement',
            status: 'disputed',
            review: true,
            vlmType: 'statement',
            classification: { type: 'bill', confidence: 0.68, votes: { bill: 1.3 } },
          }),
          file: 'stmt.png',
          result: {
            valid: true,
            jsonChannel: 'thinking',
            raw: {},
            usage,
            error: null,
            document: {
              type: 'statement',
              summary: 'Looks like a statement.',
              action_items: [],
              institution: 'Metro Power',
              account_number: '123',
              period_start: null,
              period_end: null,
              balance: null,
            },
          },
        },
      ],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('stmt.png  [statement, classifier says bill 0.68, needs review]');
    expect(text).toContain('Review: 1 of 1 item(s) flagged.');
  });

  it('renders a low-confidence disagreement as unknown', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: [],
      items: [
        billItem({
          effectiveType: 'unknown',
          status: 'low_confidence',
          review: true,
          vlmType: 'bill',
          classification: { type: 'statement', confidence: 0.53, votes: { statement: 0.7 } },
        }),
      ],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain(
      'renewal.png  [unknown, type unclear (vlm bill vs classifier statement 0.53), needs review]',
    );
  });

  it('notes classifier degradation instead of a review tally', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: [],
      items: [billItem(unclassified)],
      classifierError: 'embedder unreachable',
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill]');
    expect(text).toContain(
      'Classifier unavailable (embedder unreachable); types are single-stage VLM labels.',
    );
    expect(text).not.toContain('Review:');
  });

  it('renders a failed extraction without throwing', () => {
    const report: ScanReport = {
      scanned: ['x.png'],
      skipped: [],
      items: [
        {
          file: 'x.png',
          result: {
            valid: false,
            jsonChannel: null,
            raw: null,
            usage,
            error: 'no JSON',
            document: null,
          },
          reconciliation: {
            effectiveType: 'unknown',
            status: 'unclassified',
            review: true,
            vlmType: null,
            classification: null,
          },
        },
      ],
      classifierError: null,
    };
    expect(formatReport('pile', report)).toContain('could not extract: no JSON');
  });
});

describe('formatCitations', () => {
  it('renders ranked citations with scores and sources', () => {
    const result: FindResult = {
      scanned: { scanned: ['a.png', 'b.png'], skipped: [], items: [], classifierError: null },
      citations: [
        {
          text: 'Metro Electric bill, $91 due Feb 16.',
          score: 0.94,
          source: { documentId: 'a.png', page: undefined, chunkIndex: 0 },
        },
        {
          text: 'Grocery receipt with butter.',
          score: 0.71,
          source: { documentId: 'b.png', page: 2, chunkIndex: 1 },
        },
      ],
    };
    const text = formatCitations('metro electric', result);
    expect(text).toContain('Query: metro electric');
    expect(text).toContain('Scanned 2 document(s).');
    expect(text).toContain('1. [0.94] a.png');
    expect(text).toContain('2. [0.71] b.png p2');
  });

  it('says so when nothing is relevant', () => {
    const result: FindResult = {
      scanned: { scanned: [], skipped: [], items: [], classifierError: null },
      citations: [],
    };
    expect(formatCitations('x', result)).toContain('No relevant passages found.');
  });
});
