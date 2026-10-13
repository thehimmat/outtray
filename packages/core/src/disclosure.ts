/**
 * What the user is told about identifier storage (ADR-0011 section 3 and its
 * amendment, issue #79).
 *
 * The text lives in core, not the CLI, so the Phase 3 UI shows the same words.
 * ADR-0011 sets an honesty requirement: state the best-effort limit plainly
 * without becoming a wall of caveats. `disclosure.test.ts` pins each claim the
 * ADR requires, so rewording cannot quietly drop one.
 */

/**
 * The full disclosure, shown before identifier storage is turned on and by
 * `outtray settings`.
 */
export const IDENTIFIER_STORAGE_DISCLOSURE = `Outtray can remember your ID numbers (passport, policy and account numbers)
so you can look one up later, or it can forget them and only ever show the
last four. It forgets them: this is off unless you turn it on.

If you turn it on:
- Each number is kept once, in full, in the encrypted database on this Mac,
  and shown only when you ask for that one number with \`outtray reveal\`.
- Numbers are remembered from the next scan of each document, not before.
- Turning it off deletes every number it remembered.

Either way, Outtray removes ID numbers from the other text it keeps and shows.
That is best effort: a number the model rewrote can slip through. Names and
addresses stay in the encrypted database as ordinary text.
`;

/**
 * The short notice shown the first time a scan creates the store.
 *
 * Failure modes: none; pure.
 */
export function firstRunNotice(identifierStorage: boolean, databasePath: string): string {
  const ids = identifierStorage
    ? 'Identifier storage is on, so ID numbers are kept in full; turn it off with\n' +
      '`outtray settings identifier-storage off`.'
    : 'ID numbers are reduced to their last four; `outtray settings` explains how to\n' +
      'have Outtray remember them instead.';
  return `Outtray keeps an encrypted copy of what it reads at ${databasePath}.\n${ids}\n`;
}
