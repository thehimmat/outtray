import type { FindResult, ScanReport } from '@outtray/core';
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

  it('renders type, summary, actions, and the skipped list', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: ['notes.txt'],
      items: [
        {
          file: 'renewal.png',
          result: {
            valid: true,
            jsonChannel: 'thinking',
            raw: {},
            usage,
            error: null,
            document: {
              type: 'bill',
              summary: 'DMV renewal, $301 due Aug 31.',
              action_items: [{ text: 'Pay $301.00', due_date: '2026-08-31' }],
              payee: 'State DMV',
              amount_due: '$301.00',
              due_date: '2026-08-31',
              late_fee: '$54.00',
            },
          },
        },
      ],
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill]');
    expect(text).toContain('DMV renewal');
    expect(text).toContain('- Pay $301.00 (due 2026-08-31)');
    expect(text).toContain('Skipped: notes.txt');
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
        },
      ],
    };
    expect(formatReport('pile', report)).toContain('could not extract: no JSON');
  });
});

describe('formatCitations', () => {
  it('renders ranked citations with scores and sources', () => {
    const result: FindResult = {
      scanned: { scanned: ['a.png', 'b.png'], skipped: [], items: [] },
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
      scanned: { scanned: [], skipped: [], items: [] },
      citations: [],
    };
    expect(formatCitations('x', result)).toContain('No relevant passages found.');
  });
});
