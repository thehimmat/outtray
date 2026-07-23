import { describe, expect, it } from 'vitest';
import type { Classification } from './classifier.js';
import type { ExtractResult } from './extract.js';
import type { DocumentExtraction, DocumentType } from './extraction-schema.js';
import { applyCorrection, CLASSIFIER_K, CONFIDENCE_THRESHOLD, reconcileType } from './reconcile.js';

function cls(type: DocumentType, confidence: number): Classification {
  return { type, confidence, votes: { [type]: confidence } };
}

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };

function retryWith(document: DocumentExtraction | null): ExtractResult {
  return {
    document,
    valid: document !== null,
    jsonChannel: 'content',
    raw: document,
    usage,
    error: document ? null : 'no JSON parsed from model output',
  };
}

const BILL_DOC: DocumentExtraction = {
  type: 'bill',
  summary: 'x',
  action_items: [],
  payee: 'p',
  amount_due: '$1',
  due_date: null,
  late_fee: null,
};

describe('reconcileType', () => {
  it('confirms when the classifier agrees, at any confidence', () => {
    const r = reconcileType('bill', cls('bill', 0.31));
    expect(r.status).toBe('confirmed');
    expect(r.effectiveType).toBe('bill');
    expect(r.review).toBe(false);
    expect(r.classification?.type).toBe('bill');
  });

  it('disputes a confident disagreement and flags it for review, keeping the VLM label', () => {
    const r = reconcileType('statement', cls('bill', 0.85));
    expect(r.status).toBe('disputed');
    expect(r.effectiveType).toBe('statement');
    expect(r.review).toBe(true);
    expect(r.classification?.type).toBe('bill');
  });

  it('treats confidence exactly at the threshold as confident', () => {
    const r = reconcileType('statement', cls('bill', CONFIDENCE_THRESHOLD));
    expect(r.status).toBe('disputed');
  });

  it('routes a low-confidence disagreement to unknown and review', () => {
    const r = reconcileType('statement', cls('bill', 0.53));
    expect(r.status).toBe('low_confidence');
    expect(r.effectiveType).toBe('unknown');
    expect(r.review).toBe(true);
  });

  it('respects a caller-supplied threshold', () => {
    expect(reconcileType('statement', cls('bill', 0.53), 0.5).status).toBe('disputed');
    expect(reconcileType('statement', cls('bill', 0.53), 0.9).status).toBe('low_confidence');
  });

  it('leaves an unclassified valid document on its VLM label without review', () => {
    const r = reconcileType('bill', null);
    expect(r.status).toBe('unclassified');
    expect(r.effectiveType).toBe('bill');
    expect(r.review).toBe(false);
    expect(r.classification).toBeNull();
  });

  it('routes an invalid extraction (no VLM label) to unknown and review', () => {
    const r = reconcileType(null, null);
    expect(r.status).toBe('unclassified');
    expect(r.effectiveType).toBe('unknown');
    expect(r.review).toBe(true);
  });

  it('exports the measured defaults from the ADR-0009 amendment', () => {
    expect(CLASSIFIER_K).toBe(3);
    expect(CONFIDENCE_THRESHOLD).toBe(0.6);
  });
});

describe('applyCorrection', () => {
  const disputed = reconcileType('statement', cls('bill', 0.85));

  it('upgrades a dispute when the retry validates as the target type', () => {
    const upgraded = applyCorrection(disputed, retryWith(BILL_DOC));
    expect(upgraded.status).toBe('corrected');
    expect(upgraded.effectiveType).toBe('bill');
    expect(upgraded.review).toBe(false);
    expect(upgraded.vlmType).toBe('statement');
  });

  it('returns the dispute unchanged when the retry is invalid', () => {
    expect(applyCorrection(disputed, retryWith(null))).toBe(disputed);
  });

  it('returns the dispute unchanged when the retry comes back off-type', () => {
    const offType = retryWith({
      type: 'receipt',
      summary: 'x',
      action_items: [],
      merchant: 'm',
      total: '$1',
      purchased_at: null,
    });
    expect(applyCorrection(disputed, offType)).toBe(disputed);
  });

  it('never upgrades a non-disputed reconciliation', () => {
    const confirmed = reconcileType('bill', cls('bill', 0.9));
    expect(applyCorrection(confirmed, retryWith(BILL_DOC))).toBe(confirmed);
  });
});
