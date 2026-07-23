import { describe, expect, it } from 'vitest';
import type { Classification } from './classifier.js';
import type { DocumentType } from './extraction-schema.js';
import { CLASSIFIER_K, CONFIDENCE_THRESHOLD, reconcileType } from './reconcile.js';

function cls(type: DocumentType, confidence: number): Classification {
  return { type, confidence, votes: { [type]: confidence } };
}

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
