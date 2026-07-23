/**
 * The action layer v1 (ADR-0010): turn a scan report into a proposed action
 * queue, deterministically.
 *
 * Planning is a pure function over Zod-validated extractions and their
 * ADR-0009 reconciliation verdicts; there is no model call and no prompt, so
 * document text cannot reach instruction position (ADR-0008 point 1 holds by
 * construction) and CI tests the whole layer hermetically. Every item carries
 * verbatim citations of the extracted evidence (point 2), is only ever
 * `proposed` (point 3: the agent proposes, the human acts, and no destructive
 * tool exists), and the queue never renders an all-clear (point 5). Retention
 * advice cites the rule that produced it and carries the non-advice
 * disclaimer (point 6).
 */

import type { DocumentExtraction, DocumentType } from './extraction-schema.js';
import type { ScanReport } from './scan.js';

/** What kind of proposed action an item is. */
export type ActionKind = 'attention_flag' | 'todo' | 'expiry_alert' | 'retention_advice';

/** Retention advice verdicts. Rendered as text; nothing executes them (ADR-0008). */
export type RetentionAdvice = 'keep' | 'shred' | 'trash';

/** A verbatim piece of extracted evidence backing an action item. */
export interface ActionCitation {
  /** The source document (file name within the scanned directory). */
  documentId: string;
  /** Verbatim extracted text or `field: value` pair; never a paraphrase. */
  snippet: string;
}

/** One proposed action. */
export interface ActionItem {
  /** Stable within a queue: `<ruleId>:<documentId>` plus a counter on collision. */
  id: string;
  kind: ActionKind;
  /** The id of the rule that produced this item, for traceability. */
  ruleId: string;
  title: string;
  /** ISO date the item is anchored to (due, expiry), or null. */
  date: string | null;
  /** Retention verdict, only on `retention_advice` items. */
  advice: RetentionAdvice | null;
  /**
   * True when the source document's reconciliation asks for human review
   * first; such items are grouped apart and never presented as settled.
   */
  needsReviewFirst: boolean;
  citations: ActionCitation[];
  /** Always `proposed` in v1; a human acts outside the tool. */
  status: 'proposed';
}

/** The planned queue for one scan. */
export interface ActionQueue {
  items: ActionItem[];
  /** Number of `attention_flag` items. Zero means "none flagged", never "all clear". */
  flagged: number;
  /** Items a human should look at before trusting (review-gated or flagged). */
  needsReview: number;
  /** The ADR-0008 point 6 non-advice disclaimer, rendered with every queue. */
  disclaimer: string;
}

/** Options for planning; `today` is injected so planning stays deterministic. */
export interface PlanOptions {
  /** ISO date (YYYY-MM-DD) used for past-due and expiry-window checks. */
  today: string;
  /** How many days ahead an expiry or termination date is worth alerting on. */
  expiryWindowDays?: number;
}

export const DISCLAIMER =
  'Retention advice is general information, not legal or tax advice; ' +
  'rules vary by jurisdiction and situation.';

const DEFAULT_EXPIRY_WINDOW_DAYS = 60;

/** The v1 retention rules table: deliberately small, readable, and cited by id. */
const RETENTION_RULES: Partial<
  Record<DocumentType, { advice: RetentionAdvice; ruleId: string; note: string }>
> = {
  bill: {
    advice: 'shred',
    ruleId: 'ret-bill',
    note: 'Shred once payment has cleared; keep about a year if tax-relevant.',
  },
  receipt: {
    advice: 'shred',
    ruleId: 'ret-receipt',
    note: 'Shred unless tax-relevant or needed for a return or warranty.',
  },
  statement: {
    advice: 'keep',
    ruleId: 'ret-statement',
    note: 'Keep one year; seven if tax-relevant.',
  },
  id_document: {
    advice: 'keep',
    ruleId: 'ret-id-document',
    note: 'Keep; identity documents are irreplaceable. Never trash.',
  },
  policy: {
    advice: 'keep',
    ruleId: 'ret-policy',
    note: 'Keep while the policy is active, plus one renewal cycle.',
  },
  contract: {
    advice: 'keep',
    ruleId: 'ret-contract',
    note: 'Keep while in force and for several years after termination.',
  },
};

/** The expiry-bearing field per type, for expiry alerts and expired flags. */
const EXPIRY_FIELDS: Partial<Record<DocumentType, { field: string; ruleId: string }>> = {
  id_document: { field: 'expiry_date', ruleId: 'expiry-id-document' },
  policy: { field: 'expiry_date', ruleId: 'expiry-policy' },
  contract: { field: 'termination_date', ruleId: 'expiry-contract' },
};

const KIND_ORDER: Record<ActionKind, number> = {
  attention_flag: 0,
  todo: 1,
  expiry_alert: 2,
  retention_advice: 3,
};

function isoDaysFrom(today: string, days: number): string {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

function readDateField(doc: DocumentExtraction, field: string): string | null {
  const raw = (doc as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * Plan the proposed action queue for a scan report.
 *
 * Failure modes: none; pure and total. Invalid extractions become attention
 * flags rather than being dropped, and documents whose effective type is
 * `unknown` produce no retention advice (nothing is advised on an untrusted
 * label). Date comparisons are lexicographic over ISO dates; a malformed
 * extracted date simply fails its window checks rather than throwing.
 */
export function planActions(report: ScanReport, options: PlanOptions): ActionQueue {
  const windowEnd = isoDaysFrom(
    options.today,
    options.expiryWindowDays ?? DEFAULT_EXPIRY_WINDOW_DAYS,
  );
  const items: ActionItem[] = [];
  const add = (item: Omit<ActionItem, 'id' | 'status'>, documentId: string) => {
    items.push({ ...item, id: `${item.ruleId}:${documentId}`, status: 'proposed' });
  };

  for (const scanItem of report.items) {
    const { file, result, reconciliation } = scanItem;
    const review = reconciliation.review;
    const doc = result.document;

    if (!result.valid || !doc) {
      add(
        {
          kind: 'attention_flag',
          ruleId: 'flag-invalid',
          title: `Could not read ${file}`,
          date: null,
          advice: null,
          needsReviewFirst: true,
          citations: [{ documentId: file, snippet: result.error ?? 'extraction failed' }],
        },
        file,
      );
      continue;
    }

    // Type-trust flags from the reconciliation verdict (ADR-0009).
    if (reconciliation.status === 'disputed' && reconciliation.classification) {
      const c = reconciliation.classification;
      add(
        {
          kind: 'attention_flag',
          ruleId: 'flag-disputed',
          title: `Type disputed for ${file}: extractor says ${reconciliation.vlmType}, classifier says ${c.type}`,
          date: null,
          advice: null,
          needsReviewFirst: true,
          citations: [
            { documentId: file, snippet: `type: ${reconciliation.vlmType}` },
            { documentId: file, snippet: `classifier: ${c.type} (${c.confidence.toFixed(2)})` },
          ],
        },
        file,
      );
    } else if (reconciliation.status === 'low_confidence') {
      add(
        {
          kind: 'attention_flag',
          ruleId: 'flag-type-unclear',
          title: `Type unclear for ${file}`,
          date: null,
          advice: null,
          needsReviewFirst: true,
          citations: [{ documentId: file, snippet: `type: ${reconciliation.vlmType}` }],
        },
        file,
      );
    }

    // To-dos from the document's own extracted action items.
    for (const action of doc.action_items) {
      const due = action.due_date;
      const pastDue = due !== null && due < options.today;
      add(
        {
          kind: pastDue ? 'attention_flag' : 'todo',
          ruleId: pastDue ? 'flag-past-due' : 'todo-extracted',
          title: pastDue ? `Past due: ${action.text} (was due ${due})` : action.text,
          date: due,
          advice: null,
          needsReviewFirst: review,
          citations: [{ documentId: file, snippet: action.text }],
        },
        file,
      );
    }

    // Expiry alerts and expired flags from type-specific date fields.
    const expiry = EXPIRY_FIELDS[reconciliation.effectiveType];
    if (expiry) {
      const date = readDateField(doc, expiry.field);
      if (date !== null && date < options.today) {
        add(
          {
            kind: 'attention_flag',
            ruleId: 'flag-expired',
            title: `${file} expired ${date}`,
            date,
            advice: null,
            needsReviewFirst: review,
            citations: [{ documentId: file, snippet: `${expiry.field}: ${date}` }],
          },
          file,
        );
      } else if (date !== null && date <= windowEnd) {
        add(
          {
            kind: 'expiry_alert',
            ruleId: expiry.ruleId,
            title: `${file} expires ${date}`,
            date,
            advice: null,
            needsReviewFirst: review,
            citations: [{ documentId: file, snippet: `${expiry.field}: ${date}` }],
          },
          file,
        );
      }
    }

    // Retention advice from the static rules table, keyed by the trusted type.
    const retention = RETENTION_RULES[reconciliation.effectiveType];
    if (retention) {
      add(
        {
          kind: 'retention_advice',
          ruleId: retention.ruleId,
          title: retention.note,
          date: null,
          advice: retention.advice,
          needsReviewFirst: review,
          citations: [{ documentId: file, snippet: `type: ${reconciliation.effectiveType}` }],
        },
        file,
      );
    }
  }

  // Merge duplicate to-dos (same title and date across documents).
  const merged: ActionItem[] = [];
  const todoByKey = new Map<string, ActionItem>();
  for (const item of items) {
    if (item.kind !== 'todo') {
      merged.push(item);
      continue;
    }
    const key = `${item.title.trim().toLowerCase()}|${item.date ?? ''}`;
    const existing = todoByKey.get(key);
    if (existing) {
      existing.citations.push(...item.citations);
      existing.needsReviewFirst = existing.needsReviewFirst || item.needsReviewFirst;
    } else {
      todoByKey.set(key, item);
      merged.push(item);
    }
  }

  merged.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
      a.id.localeCompare(b.id),
  );

  // Disambiguate ids only when one rule fires more than once for a document.
  const seen = new Map<string, number>();
  for (const item of merged) {
    const n = seen.get(item.id) ?? 0;
    seen.set(item.id, n + 1);
    if (n > 0) item.id = `${item.id}:${n}`;
  }

  const flagged = merged.filter((i) => i.kind === 'attention_flag').length;
  const needsReview = merged.filter((i) => i.needsReviewFirst).length;
  return { items: merged, flagged, needsReview, disclaimer: DISCLAIMER };
}
