import { describe, expect, it } from 'vitest';
import type { ActionItem, ActionQueue } from './actions.js';
import { reviewTargets } from './review-marks.js';
import type { ScanReport } from './scan.js';

function item(id: string, ruleId: string, date: string | null = null): ActionItem {
  return {
    id,
    kind: 'todo',
    ruleId,
    title: 't',
    date,
    advice: null,
    needsReviewFirst: false,
    citations: [],
    status: 'proposed',
  };
}

const queue = (items: ActionItem[]): ActionQueue => ({
  items,
  flagged: 0,
  needsReview: 0,
  disclaimer: '',
});

function report(files: Record<string, string>): ScanReport {
  return {
    scanned: Object.keys(files),
    skipped: [],
    classifierError: null,
    items: Object.entries(files).map(([file, contentHash]) => ({
      file,
      contentHash,
      result: { valid: false } as ScanReport['items'][number]['result'],
      reconciliation: {} as ScanReport['items'][number]['reconciliation'],
    })),
  };
}

describe('reviewTargets', () => {
  it('keys an item by rule, document bytes and date, not by file name', () => {
    const targets = reviewTargets(
      queue([item('todo.pay:bill.png', 'todo.pay', '2027-02-16')]),
      report({ 'bill.png': 'h1' }),
    );
    expect(targets.get('todo.pay:bill.png')).toEqual({
      key: 'todo.pay|h1|2027-02-16',
      documentHash: 'h1',
    });
  });

  it('gives a renamed file the same key and edited bytes a new one', () => {
    const a = reviewTargets(queue([item('r:a.png', 'r')]), report({ 'a.png': 'h1' }));
    const renamed = reviewTargets(queue([item('r:b.png', 'r')]), report({ 'b.png': 'h1' }));
    const edited = reviewTargets(queue([item('r:a.png', 'r')]), report({ 'a.png': 'h2' }));
    expect(renamed.get('r:b.png')?.key).toBe(a.get('r:a.png')?.key);
    expect(edited.get('r:a.png')?.key).not.toBe(a.get('r:a.png')?.key);
  });

  it('keeps the counter that tells two firings of one rule on one document apart', () => {
    const targets = reviewTargets(
      queue([item('r:a.png', 'r'), item('r:a.png:1', 'r')]),
      report({ 'a.png': 'h1' }),
    );
    expect(targets.get('r:a.png')?.key).toBe('r|h1|');
    expect(targets.get('r:a.png:1')?.key).toBe('r|h1|:1');
  });

  it('matches the longest file name, so a name containing a colon resolves', () => {
    const targets = reviewTargets(
      queue([item('r:a:b.png', 'r')]),
      report({ a: 'short', 'a:b.png': 'long' }),
    );
    expect(targets.get('r:a:b.png')?.documentHash).toBe('long');
  });

  it('leaves out an item whose document is not in the report', () => {
    const targets = reviewTargets(queue([item('r:gone.png', 'r')]), report({ 'a.png': 'h1' }));
    expect(targets.has('r:gone.png')).toBe(false);
  });
});
