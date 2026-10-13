// @vitest-environment jsdom
import type { ActionItem, ActionQueue } from '@outtray/core';
import { DISCLAIMER } from '@outtray/core';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { QueueView } from './QueueView.js';

afterEach(cleanup);

function action(overrides: Partial<ActionItem>): ActionItem {
  return {
    id: 'x',
    kind: 'todo',
    ruleId: 'todo-extracted',
    title: 'Pay Metro Electric $91.00',
    date: '2027-02-16',
    advice: null,
    needsReviewFirst: false,
    citations: [{ documentId: 'bill.png', snippet: 'Pay Metro Electric $91.00' }],
    status: 'proposed',
    ...overrides,
  };
}

function queue(items: ActionItem[]): ActionQueue {
  const flagged = items.filter((i) => i.kind === 'attention_flag').length;
  return {
    items,
    flagged,
    needsReview: items.filter((i) => i.needsReviewFirst || i.kind === 'attention_flag').length,
    disclaimer: DISCLAIMER,
  };
}

const MIXED = queue([
  action({
    id: 'a',
    kind: 'retention_advice',
    ruleId: 'ret-bill',
    title: 'Shred once paid.',
    date: null,
    advice: 'shred',
  }),
  action({ id: 'b' }),
  action({
    id: 'c',
    kind: 'attention_flag',
    ruleId: 'flag-expired',
    title: 'license.png expired 2026-01-19',
    date: '2026-01-19',
    citations: [{ documentId: 'license.png', snippet: 'expiry_date: 2026-01-19' }],
  }),
  action({
    id: 'd',
    kind: 'expiry_alert',
    ruleId: 'expiry-policy',
    title: 'policy.png expires 2026-09-01',
    date: '2026-09-01',
    needsReviewFirst: true,
  }),
]);

describe('QueueView', () => {
  it('groups items in the CLI order: attention, to do, expiring, retention advice', () => {
    render(<QueueView queue={MIXED} />);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Attention', 'To do', 'Expiring', 'Retention advice']);
  });

  it('shows every item with its citations, so each proposal says where it came from', () => {
    render(<QueueView queue={MIXED} />);
    const flag = screen.getByRole('listitem', { name: /license\.png expired 2026-01-19/ });
    expect(within(flag).getByText(/expiry_date: 2026-01-19/)).toBeTruthy();
    expect(within(flag).getByText(/license\.png/, { selector: '.source' })).toBeTruthy();
  });

  it('marks review-gated items and labels retention advice', () => {
    render(<QueueView queue={MIXED} />);
    const gated = screen.getByRole('listitem', { name: /policy\.png expires/ });
    expect(within(gated).getByText('Review first')).toBeTruthy();
    const advice = screen.getByRole('listitem', { name: /Shred once paid/ });
    expect(within(advice).getByText('Shred')).toBeTruthy();
  });

  it('always shows the retention disclaimer', () => {
    render(<QueueView queue={MIXED} />);
    expect(screen.getByText(DISCLAIMER)).toBeTruthy();
  });

  it('never says "all clear", even with nothing flagged (ADR-0008)', () => {
    render(<QueueView queue={queue([action({})])} />);
    expect(screen.getByText(/0 flagged for attention/)).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toMatch(
      /all clear|nothing to do|you're done/,
    );
  });

  it('says plainly when nothing could be planned', () => {
    render(<QueueView queue={queue([])} />);
    expect(screen.getByText(/Nothing to propose: no documents were readable/)).toBeTruthy();
  });

  it('lets the person mark an item reviewed and counts it, without acting on any file', async () => {
    const user = userEvent.setup();
    render(<QueueView queue={MIXED} />);
    expect(screen.getByText(/2 not yet reviewed by you/)).toBeTruthy();
    const gated = screen.getByRole('listitem', { name: /policy\.png expires/ });
    await user.click(within(gated).getByRole('checkbox', { name: /Reviewed/ }));
    expect(screen.getByText(/1 not yet reviewed by you/)).toBeTruthy();
  });

  it('starts from the marks the host saved', () => {
    const gatedId = MIXED.items.find((i) => i.needsReviewFirst)?.id ?? '';
    render(<QueueView queue={MIXED} initialReviewed={[gatedId]} />);
    expect(screen.getByText(/1 not yet reviewed by you/)).toBeTruthy();
  });

  it('hands each tick to the host to save', async () => {
    const user = userEvent.setup();
    const saved: Array<[string, boolean]> = [];
    render(
      <QueueView
        queue={MIXED}
        onReviewedChange={async (id, reviewed) => {
          saved.push([id, reviewed]);
        }}
      />,
    );
    const gated = screen.getByRole('listitem', { name: /policy\.png expires/ });
    const box = within(gated).getByRole('checkbox', { name: /Reviewed/ });
    await user.click(box);
    await user.click(box);
    const gatedId = MIXED.items.find((i) => i.needsReviewFirst)?.id;
    expect(saved).toEqual([
      [gatedId, true],
      [gatedId, false],
    ]);
  });

  it('undoes a tick the host could not save, and says so', async () => {
    const user = userEvent.setup();
    render(
      <QueueView
        queue={MIXED}
        onReviewedChange={async () => {
          throw new Error('Storage is closed.');
        }}
      />,
    );
    const gated = screen.getByRole('listitem', { name: /policy\.png expires/ });
    await user.click(within(gated).getByRole('checkbox', { name: /Reviewed/ }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not save that mark: Storage is closed.',
    );
    expect(screen.getByText(/2 not yet reviewed by you/)).toBeTruthy();
  });

  it('has no control that deletes, moves or shreds anything (ADR-0008)', () => {
    render(<QueueView queue={MIXED} />);
    const labels = screen.queryAllByRole('button').map((b) => b.textContent?.toLowerCase() ?? '');
    expect(labels.filter((l) => /delete|shred|move|trash/.test(l))).toEqual([]);
  });
});
