/**
 * Review marks: which proposed actions a person has looked at (ADR-0010
 * amendment 1).
 *
 * An item's queue id names the file it came from, which changes on a rename
 * and stays the same when the file is edited: the opposite of what a mark
 * needs. The review key names the document's bytes instead, so a moved file
 * keeps its marks and a re-issued bill starts unreviewed. A mark never acts on
 * anything (ADR-0008); it is the person's own note.
 */

import type { ActionQueue } from './actions.js';
import type { ScanReport } from './scan.js';

/** Where one queue item's mark is stored. */
export interface ReviewTarget {
  /** `ruleId|contentHash|date` plus the queue's collision counter, if any. No document text. */
  key: string;
  documentHash: string;
}

/**
 * The review key of every item in `queue` whose document is in `report`,
 * by item id.
 *
 * Failure modes: none; pure. An item whose id does not name a file in the
 * report is left out, so it can be ticked for the session but not saved.
 */
export function reviewTargets(queue: ActionQueue, report: ScanReport): Map<string, ReviewTarget> {
  // Longest first, so `a:b.png` wins over `a` for the id `rule:a:b.png`.
  const files = [...report.items].sort((a, b) => b.file.length - a.file.length);
  const targets = new Map<string, ReviewTarget>();
  for (const item of queue.items) {
    const rest = item.id.slice(item.ruleId.length + 1);
    const doc = files.find((f) => rest === f.file || rest.startsWith(`${f.file}:`));
    if (!doc) continue;
    const counter = rest.slice(doc.file.length);
    targets.set(item.id, {
      key: `${item.ruleId}|${doc.contentHash}|${item.date ?? ''}${counter}`,
      documentHash: doc.contentHash,
    });
  }
  return targets;
}
