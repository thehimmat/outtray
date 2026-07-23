import { describe, expect, it } from 'vitest';
import { DISCLAIMER, planActions } from './actions.js';
import type { DocumentExtraction } from './extraction-schema.js';
import type { Reconciliation } from './reconcile.js';
import type { ScanItem, ScanReport } from './scan.js';

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };
const TODAY = '2026-07-22';

function confirmed(type: DocumentExtraction['type']): Reconciliation {
  return {
    effectiveType: type,
    status: 'confirmed',
    review: false,
    vlmType: type,
    classification: { type, confidence: 0.7, votes: { [type]: 1 } },
  };
}

function item(file: string, doc: DocumentExtraction, reconciliation?: Reconciliation): ScanItem {
  return {
    file,
    result: { valid: true, jsonChannel: 'content', raw: doc, usage, error: null, document: doc },
    reconciliation: reconciliation ?? confirmed(doc.type),
  };
}

function report(items: ScanItem[]): ScanReport {
  return { scanned: items.map((i) => i.file), skipped: [], items, classifierError: null };
}

const BILL: DocumentExtraction = {
  type: 'bill',
  summary: 'DMV renewal.',
  action_items: [{ text: 'Pay $301.00', due_date: '2026-08-31' }],
  payee: 'State DMV',
  amount_due: '$301.00',
  due_date: '2026-08-31',
  late_fee: null,
};

const POLICY: DocumentExtraction = {
  type: 'policy',
  summary: 'Auto policy.',
  action_items: [],
  insurer: 'Acme',
  policy_number: 'P-1',
  coverage_summary: 'auto',
  expiry_date: '2026-08-15',
};

describe('planActions', () => {
  it('turns extracted action items into cited to-dos', () => {
    const queue = planActions(report([item('renewal.png', BILL)]), { today: TODAY });
    const todo = queue.items.find((i) => i.kind === 'todo');
    expect(todo?.title).toBe('Pay $301.00');
    expect(todo?.date).toBe('2026-08-31');
    expect(todo?.ruleId).toBe('todo-extracted');
    expect(todo?.status).toBe('proposed');
    expect(todo?.citations).toEqual([{ documentId: 'renewal.png', snippet: 'Pay $301.00' }]);
  });

  it('merges duplicate to-dos across documents, keeping both citations', () => {
    const queue = planActions(report([item('a.png', BILL), item('b.png', BILL)]), {
      today: TODAY,
    });
    const todos = queue.items.filter((i) => i.kind === 'todo');
    expect(todos).toHaveLength(1);
    expect(todos[0]?.citations.map((c) => c.documentId)).toEqual(['a.png', 'b.png']);
  });

  it('flags past-due action items instead of listing them as plain to-dos', () => {
    const overdue: DocumentExtraction = {
      ...BILL,
      action_items: [{ text: 'Pay $91.00', due_date: '2026-02-16' }],
    };
    const queue = planActions(report([item('old.png', overdue)]), { today: TODAY });
    const flag = queue.items.find((i) => i.ruleId === 'flag-past-due');
    expect(flag?.kind).toBe('attention_flag');
    expect(flag?.title).toContain('Past due');
    expect(flag?.title).toContain('2026-02-16');
    expect(queue.items.some((i) => i.kind === 'todo')).toBe(false);
  });

  it('alerts on an expiry inside the window and cites the field', () => {
    const queue = planActions(report([item('policy.png', POLICY)]), { today: TODAY });
    const alert = queue.items.find((i) => i.kind === 'expiry_alert');
    expect(alert?.ruleId).toBe('expiry-policy');
    expect(alert?.title).toBe('policy.png expires 2026-08-15');
    expect(alert?.citations).toEqual([
      { documentId: 'policy.png', snippet: 'expiry_date: 2026-08-15' },
    ]);
  });

  it('stays quiet about an expiry beyond the window and flags one already past', () => {
    const far = { ...POLICY, expiry_date: '2027-06-01' };
    const past = { ...POLICY, expiry_date: '2026-01-01' };
    const queue = planActions(report([item('far.png', far), item('past.png', past)]), {
      today: TODAY,
    });
    expect(queue.items.filter((i) => i.kind === 'expiry_alert')).toHaveLength(0);
    const flag = queue.items.find((i) => i.ruleId === 'flag-expired');
    expect(flag?.title).toBe('past.png expired 2026-01-01');
  });

  it('gives retention advice from the rules table with the rule id', () => {
    const queue = planActions(report([item('renewal.png', BILL)]), { today: TODAY });
    const advice = queue.items.find((i) => i.kind === 'retention_advice');
    expect(advice?.advice).toBe('shred');
    expect(advice?.ruleId).toBe('ret-bill');
    expect(advice?.citations).toEqual([{ documentId: 'renewal.png', snippet: 'type: bill' }]);
  });

  it('gives no retention advice on an untrusted (unknown) effective type, and flags it', () => {
    const lowConfidence: Reconciliation = {
      effectiveType: 'unknown',
      status: 'low_confidence',
      review: true,
      vlmType: 'bill',
      classification: { type: 'statement', confidence: 0.5, votes: { statement: 0.6 } },
    };
    const queue = planActions(report([item('odd.png', BILL, lowConfidence)]), { today: TODAY });
    expect(queue.items.some((i) => i.kind === 'retention_advice')).toBe(false);
    expect(queue.items.some((i) => i.ruleId === 'flag-type-unclear')).toBe(true);
  });

  it('flags a disputed type and gates the document behind review', () => {
    const disputed: Reconciliation = {
      effectiveType: 'statement',
      status: 'disputed',
      review: true,
      vlmType: 'statement',
      classification: { type: 'bill', confidence: 0.68, votes: { bill: 1.3 } },
    };
    const statementDoc: DocumentExtraction = {
      type: 'statement',
      summary: 's',
      action_items: [{ text: 'Check balance', due_date: null }],
      institution: 'i',
      account_number: 'a',
      period_start: null,
      period_end: null,
      balance: null,
    };
    const queue = planActions(report([item('stmt.png', statementDoc, disputed)]), {
      today: TODAY,
    });
    const flag = queue.items.find((i) => i.ruleId === 'flag-disputed');
    expect(flag?.title).toContain('extractor says statement');
    expect(flag?.title).toContain('classifier says bill');
    const todo = queue.items.find((i) => i.kind === 'todo');
    expect(todo?.needsReviewFirst).toBe(true);
    expect(queue.needsReview).toBeGreaterThanOrEqual(2);
  });

  it('flags invalid extractions instead of dropping them', () => {
    const broken: ScanItem = {
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
    };
    const queue = planActions(report([broken]), { today: TODAY });
    const flag = queue.items.find((i) => i.ruleId === 'flag-invalid');
    expect(flag?.title).toBe('Could not read x.png');
    expect(flag?.citations[0]?.snippet).toBe('no JSON');
  });

  it('orders flags first, dates ascending, and reports counts with the disclaimer', () => {
    const overdue: DocumentExtraction = {
      ...BILL,
      action_items: [
        { text: 'Pay $91.00', due_date: '2026-02-16' },
        { text: 'Pay $301.00', due_date: '2026-08-31' },
      ],
    };
    const queue = planActions(report([item('a.png', overdue), item('p.png', POLICY)]), {
      today: TODAY,
    });
    const kinds = queue.items.map((i) => i.kind);
    expect(kinds).toEqual([
      'attention_flag',
      'todo',
      'expiry_alert',
      'retention_advice',
      'retention_advice',
    ]);
    expect(queue.flagged).toBe(1);
    expect(queue.disclaimer).toBe(DISCLAIMER);
  });
});
