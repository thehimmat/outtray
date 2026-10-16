/**
 * The proposed action queue (ADR-0010), rendered under ADR-0008's rules:
 * every proposal shows the evidence it came from, review-gated items say so,
 * the retention disclaimer is always shown, the summary never claims an "all
 * clear", and nothing here acts on a file. "Reviewed" is the person's own
 * note: the host may save it (ADR-0010 amendment 1), but it changes no
 * document. Neither does setting a type on an item that questions one: it is
 * a correction the host saves (#67), applied when the folder is planned again.
 */

import {
  type ActionItem,
  type ActionKind,
  type ActionQueue,
  type CorrectionOutcome,
  type DocumentType,
  PINNABLE_TYPES,
} from '@outtray/core';
import {
  Archive,
  CalendarClock,
  ListTodo,
  type LucideIcon,
  Tags,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';

const SECTIONS: Array<{ kind: ActionKind; heading: string; icon: LucideIcon }> = [
  { kind: 'attention_flag', heading: 'Attention', icon: TriangleAlert },
  { kind: 'todo', heading: 'To do', icon: ListTodo },
  { kind: 'expiry_alert', heading: 'Expiring', icon: CalendarClock },
  { kind: 'retention_advice', heading: 'Retention advice', icon: Archive },
];

const ADVICE_LABEL = { keep: 'Keep', shred: 'Shred', trash: 'Trash' } as const;

/** Plain names for the types a person can pin. */
const TYPE_LABEL: Record<DocumentType, string> = {
  bill: 'bill',
  letter: 'letter',
  receipt: 'receipt',
  id_document: 'ID document',
  contract: 'contract',
  policy: 'policy',
  statement: 'statement',
  unknown: 'unknown',
};

/** The flags that question a document's type, where a person can settle it. */
const TYPE_QUESTIONS = new Set(['flag-disputed', 'flag-type-unclear']);

/** What a saved correction means for the person, in one sentence. */
function correctionNote(type: DocumentType, outcome: CorrectionOutcome): string {
  const name = TYPE_LABEL[type];
  const next = outcome.reextract
    ? `It will be read again as ${name} when you plan the folder again`
    : 'Plan the folder again to update its actions';
  const learned = outcome.learned
    ? ', and Outtray will use it as an example for documents like it.'
    : '.';
  return `Marked as ${name}. ${next}${learned}`;
}

/** Whether an item asks for a person's look before it is trusted. */
function needsLook(item: ActionItem): boolean {
  return item.needsReviewFirst || item.kind === 'attention_flag';
}

function flip(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function QueueView({
  queue,
  initialReviewed = [],
  onReviewedChange,
  onTypeChange,
}: {
  queue: ActionQueue;
  /** Item ids the host already has marks for. */
  initialReviewed?: readonly string[];
  /** Save one tick; a rejection undoes it in the page. */
  onReviewedChange?: (itemId: string, reviewed: boolean) => Promise<void>;
  /** Pin the type of an item's document; without it, no type choice is offered. */
  onTypeChange?: (itemId: string, type: DocumentType) => Promise<CorrectionOutcome>;
}) {
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set(initialReviewed));
  const [saveError, setSaveError] = useState<string | null>(null);
  const toggle = async (id: string) => {
    const on = !reviewed.has(id);
    setReviewed((prev) => flip(prev, id, on));
    setSaveError(null);
    try {
      await onReviewedChange?.(id, on);
    } catch (error) {
      setReviewed((prev) => flip(prev, id, !on));
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const unreviewed = queue.items.filter((i) => needsLook(i) && !reviewed.has(i.id)).length;

  return (
    <section className="queue" aria-label="Proposed actions">
      <p className="summary">
        {queue.items.length} item(s) proposed. {queue.flagged} flagged for attention, {unreviewed}{' '}
        not yet reviewed by you.
      </p>
      {saveError ? (
        <p className="error" role="alert">
          Could not save that mark: {saveError}
        </p>
      ) : null}
      {queue.items.length === 0 ? (
        <p className="empty">Nothing to propose: no documents were readable.</p>
      ) : (
        SECTIONS.map(({ kind, heading, icon: Icon }) => {
          const items = queue.items.filter((i) => i.kind === kind);
          if (items.length === 0) return null;
          return (
            <div key={kind} className={`section section-${kind}`}>
              <h2>
                <Icon aria-hidden="true" size={18} />
                {heading}
              </h2>
              <ul>
                {items.map((item) => (
                  <ActionRow
                    key={item.id}
                    item={item}
                    reviewed={reviewed.has(item.id)}
                    onToggle={() => toggle(item.id)}
                    onTypeChange={
                      onTypeChange && TYPE_QUESTIONS.has(item.ruleId)
                        ? (type) => onTypeChange(item.id, type)
                        : undefined
                    }
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
      <p className="disclaimer">{queue.disclaimer}</p>
    </section>
  );
}

function ActionRow({
  item,
  reviewed,
  onToggle,
  onTypeChange,
}: {
  item: ActionItem;
  reviewed: boolean;
  onToggle: () => void;
  onTypeChange?: ((type: DocumentType) => Promise<CorrectionOutcome>) | undefined;
}) {
  const titleId = `title-${item.id}`;
  return (
    <li aria-labelledby={titleId} className={reviewed ? 'item reviewed' : 'item'}>
      <div className="item-head">
        {item.advice ? <span className="advice">{ADVICE_LABEL[item.advice]}</span> : null}
        <span id={titleId} className="title">
          {item.title}
        </span>
        {item.date ? <span className="date">{item.date}</span> : null}
        {item.needsReviewFirst ? <span className="badge">Review first</span> : null}
      </div>
      <ul className="citations">
        {item.citations.map((c) => (
          <li key={`${c.documentId}|${c.snippet}`}>
            <span className="source">{c.documentId}</span>: "{c.snippet}"
          </li>
        ))}
      </ul>
      {needsLook(item) ? (
        <label className="reviewed-toggle">
          <input type="checkbox" checked={reviewed} onChange={onToggle} /> Reviewed
        </label>
      ) : null}
      {onTypeChange ? <TypeChoice itemId={item.id} onTypeChange={onTypeChange} /> : null}
    </li>
  );
}

/** Settle a questioned type: pick one, the host pins it (#67). */
function TypeChoice({
  itemId,
  onTypeChange,
}: {
  itemId: string;
  onTypeChange: (type: DocumentType) => Promise<CorrectionOutcome>;
}) {
  const [type, setType] = useState<DocumentType | ''>('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectId = `type-${itemId}`;
  const submit = async () => {
    if (type === '') return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setNote(correctionNote(type, await onTypeChange(type)));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="type-choice">
      <label htmlFor={selectId}>Document type</label>
      <select
        id={selectId}
        value={type}
        onChange={(e) => setType(e.target.value as DocumentType | '')}
      >
        <option value="">Choose...</option>
        {PINNABLE_TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <button type="button" onClick={submit} disabled={type === '' || busy}>
        <Tags aria-hidden="true" size={16} /> Set type
      </button>
      {note ? <p role="status">{note}</p> : null}
      {error ? (
        <p className="error" role="alert">
          Could not set the type: {error}
        </p>
      ) : null}
    </div>
  );
}
