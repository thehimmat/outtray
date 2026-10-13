/**
 * The proposed action queue (ADR-0010), rendered under ADR-0008's rules:
 * every proposal shows the evidence it came from, review-gated items say so,
 * the retention disclaimer is always shown, the summary never claims an "all
 * clear", and nothing here acts on a file. "Reviewed" is the person's own
 * note: the host may save it (ADR-0010 amendment 1), but it changes no
 * document.
 */

import type { ActionItem, ActionKind, ActionQueue } from '@outtray/core';
import { Archive, CalendarClock, ListTodo, type LucideIcon, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

const SECTIONS: Array<{ kind: ActionKind; heading: string; icon: LucideIcon }> = [
  { kind: 'attention_flag', heading: 'Attention', icon: TriangleAlert },
  { kind: 'todo', heading: 'To do', icon: ListTodo },
  { kind: 'expiry_alert', heading: 'Expiring', icon: CalendarClock },
  { kind: 'retention_advice', heading: 'Retention advice', icon: Archive },
];

const ADVICE_LABEL = { keep: 'Keep', shred: 'Shred', trash: 'Trash' } as const;

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
}: {
  queue: ActionQueue;
  /** Item ids the host already has marks for. */
  initialReviewed?: readonly string[];
  /** Save one tick; a rejection undoes it in the page. */
  onReviewedChange?: (itemId: string, reviewed: boolean) => Promise<void>;
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
}: {
  item: ActionItem;
  reviewed: boolean;
  onToggle: () => void;
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
    </li>
  );
}
