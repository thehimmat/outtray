/**
 * A demo host: the real core planner over synthetic documents, in the page.
 *
 * Proves the UI and the host-neutral core work together before the Tauri
 * adapters exist (ADR-0013). The documents are invented, like the eval
 * fixtures; no real document is ever bundled.
 */

import { type DocumentExtraction, planActions, reconcileType, type ScanItem } from '@outtray/core';
import type { OuttrayApi, PlannedFolder } from './api.js';

const usage = { loadMs: 0, promptTokens: 0, genTokens: 0, genTokPerSec: null, totalMs: 0 };

/** Synthetic documents shaped like the eval fixtures. */
const DEMO: Array<[string, DocumentExtraction]> = [
  [
    'electric-bill.png',
    {
      type: 'bill',
      summary: 'Metro Electric bill, $91.00 due February 16, 2027.',
      action_items: [{ text: 'Pay Metro Electric $91.00', due_date: '2027-02-16' }],
      payee: 'Metro Electric',
      amount_due: '$91.00',
      due_date: '2027-02-16',
      late_fee: '$56.00',
    },
  ],
  [
    'drivers-license.png',
    {
      type: 'id_document',
      summary: 'Washington driver license.',
      action_items: [],
      holder_name: 'Nina Nguyen',
      id_number: 'D8923829',
      issuer: 'State of Washington',
      expiry_date: '2026-01-19',
    },
  ],
  [
    'auto-policy.png',
    {
      type: 'policy',
      summary: 'Comprehensive auto policy.',
      action_items: [],
      insurer: 'Harbor Casualty',
      policy_number: 'POL-804220',
      coverage_summary: 'Comprehensive auto, $500 deductible',
      expiry_date: '2026-12-16',
    },
  ],
  [
    'grocery-receipt.png',
    {
      type: 'receipt',
      summary: 'Northside Grocers receipt.',
      action_items: [],
      merchant: 'Northside Grocers',
      total: '$36.49',
      purchased_at: '2025-08-23',
    },
  ],
];

function item(file: string, doc: DocumentExtraction): ScanItem {
  return {
    file,
    contentHash: file,
    result: { valid: true, jsonChannel: 'content', raw: doc, usage, error: null, document: doc },
    reconciliation: reconcileType(doc.type, null),
  };
}

/**
 * The demo host. `today` is injectable so the queue is deterministic in tests.
 *
 * Failure modes: none; it never touches a real folder.
 */
export function demoApi(
  today: () => string = () => new Date().toISOString().slice(0, 10),
): OuttrayApi {
  return {
    async chooseFolder() {
      return 'Demo documents';
    },
    async planFolder(folder: string): Promise<PlannedFolder> {
      const items = DEMO.map(([file, doc]) => item(file, doc));
      const queue = planActions(
        { scanned: items.map((i) => i.file), skipped: [], items, classifierError: null },
        { today: today() },
      );
      return {
        folder,
        queue,
        scanned: items.length,
        skipped: [],
        notes: ['Demo mode: synthetic documents, planned by the real Outtray planner.'],
      };
    },
  };
}
