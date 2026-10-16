/**
 * A demo host: the real core planner over synthetic documents, in the page.
 *
 * Proves the UI and the host-neutral core work together before the Tauri
 * adapters exist (ADR-0013). The documents are invented, like the eval
 * fixtures; no real document is ever bundled.
 */

import {
  type Classification,
  type DocumentExtraction,
  type DocumentType,
  type EmbeddingProvider,
  PINNABLE_TYPES,
  planActions,
  reconcileType,
  type ScanItem,
  type ScanReport,
  searchReport,
  userVerdict,
} from '@outtray/core';
import type { OuttrayApi, PlannedFolder } from './api.js';
import { plannedDocuments } from './planned-documents.js';

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

/**
 * A document the extractor and the classifier disagree on, so the demo shows
 * a type question a person can settle.
 */
const DISPUTED: [string, DocumentExtraction, Classification] = [
  'water-bill.png',
  {
    type: 'statement',
    summary: 'City Water account summary.',
    action_items: [],
    institution: 'City Water',
    account_number: '4410-2287-19',
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    balance: '$42.10',
  },
  { type: 'bill', confidence: 0.82, votes: { bill: 4, statement: 1 } },
];

/**
 * A stand-in for the embedding model: each word lands in one of 64 buckets,
 * so passages sharing words with the query rank first. Deterministic and
 * model-free; the ranking itself is core's (`searchReport`).
 */
const wordEmbedder: EmbeddingProvider = {
  name: 'demo-words',
  async embed(texts) {
    return texts.map((text) => {
      const v: number[] = new Array<number>(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        let h = 0;
        for (const c of word) h = (h * 31 + c.charCodeAt(0)) % 64;
        v[h] = (v[h] ?? 0) + 1;
      }
      // An all-zero vector has no direction; give it one so cosine stays defined.
      if (!v.some((x) => x > 0)) v[0] = 1;
      return v;
    });
  },
};

function item(
  file: string,
  doc: DocumentExtraction,
  classification: Classification | null,
  pinned: DocumentType | undefined,
): ScanItem {
  return {
    file,
    contentHash: file,
    result: { valid: true, jsonChannel: 'content', raw: doc, usage, error: null, document: doc },
    reconciliation: pinned
      ? userVerdict(pinned, doc.type, classification)
      : reconcileType(doc.type, classification),
  };
}

/**
 * The demo host. `today` is injectable so the queue is deterministic in tests.
 *
 * Failure modes: `setDocumentType` rejects for an item not in the last plan
 * or a type that cannot be pinned, `search` before any plan, and
 * `revealIdentifier` for a document not in the last plan. It never remembers
 * a number, so a reveal always resolves `not_stored`; nothing else rejects, and it never touches
 * a real folder. Marks and pins last for the page's lifetime.
 */
export function demoApi(
  today: () => string = () => new Date().toISOString().slice(0, 10),
): OuttrayApi {
  // Kept for the page's lifetime only: the demo has no store.
  const reviewed = new Set<string>();
  const pins = new Map<string, DocumentType>();
  const files = new Map<string, string>();
  let lastReport: ScanReport | null = null;
  let identifierStorage = false;
  return {
    async chooseFolder() {
      return 'Demo documents';
    },
    async planFolder(folder: string): Promise<PlannedFolder> {
      const items = [
        ...DEMO.map(([file, doc]) => item(file, doc, null, pins.get(file))),
        item(DISPUTED[0], DISPUTED[1], DISPUTED[2], pins.get(DISPUTED[0])),
      ];
      lastReport = { scanned: items.map((i) => i.file), skipped: [], items, classifierError: null };
      const queue = planActions(lastReport, { today: today() });
      files.clear();
      for (const action of queue.items) {
        const source = items.find((i) =>
          action.id.slice(action.ruleId.length + 1).startsWith(i.file),
        );
        if (source) files.set(action.id, source.file);
      }
      return {
        folder,
        queue,
        scanned: items.length,
        skipped: [],
        notes: ['Demo mode: synthetic documents, planned by the real Outtray planner.'],
        reviewed: [...reviewed],
        documents: plannedDocuments(lastReport),
      };
    },
    async setReviewed(itemId: string, on: boolean) {
      if (on) reviewed.add(itemId);
      else reviewed.delete(itemId);
    },
    async setDocumentType(itemId: string, type: DocumentType) {
      const file = files.get(itemId);
      if (!file) throw new Error('This item is not in the last plan; plan the folder again.');
      if (!PINNABLE_TYPES.includes(type)) throw new Error(`The type ${type} cannot be pinned.`);
      pins.set(file, type);
      const extracted = [...DEMO, DISPUTED].find(([name]) => name === file)?.[1];
      // The demo cannot read a document again; the real host does (#67).
      return { reextract: extracted?.type !== type, learned: true };
    },
    async readSettings() {
      return { identifierStorage };
    },
    async setIdentifierStorage(on: boolean) {
      identifierStorage = on;
      return { identifierStorage, purged: 0 };
    },
    async revealIdentifier(file: string) {
      const item = lastReport?.items.find((i) => i.file === file);
      if (!item) throw new Error('This document is not in the last plan; plan the folder again.');
      // The demo never remembers a number, whatever the setting says.
      return 'not_stored' as const;
    },
    async search(query: string) {
      if (!lastReport) throw new Error('Plan a folder first; search looks through its documents.');
      if (query.trim() === '') return [];
      // Word buckets give unrelated passages a score of 0; a real embedder rarely does.
      return (await searchReport(wordEmbedder, lastReport, query, 5)).filter((c) => c.score > 0);
    },
  };
}
