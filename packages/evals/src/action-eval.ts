/**
 * The action-level eval (ADR-0010, issue #64): score the proposed action
 * queue, end to end from a recorded extraction, against actions authored
 * from each fixture's ground truth.
 *
 * Each fixture is extracted with the injected provider (replayed recordings
 * in CI), planned with the product's `planActions` at a fixed as-of date, and
 * its planned items are matched one to one against the expected ones. A match
 * needs the same kind, rule, date and retention advice, and a title containing
 * every required word; titles are otherwise free, because to-dos carry the
 * model's own wording. Precision and recall are reported overall and per
 * action kind, like the field scorers (METHODOLOGY.md).
 *
 * What it measures today: VLM extraction plus planning. Reconciliation runs
 * with no classifier verdict, because embeddings are not recorded yet (#52),
 * so a type the VLM gets wrong costs its actions here even where the live
 * two-stage pipeline would correct it. That gap is the point of the number.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ActionItem,
  type ActionKind,
  extract,
  type ModelProvider,
  planActions,
  type RetentionAdvice,
  reconcileType,
} from '@outtray/core';
import { fixturesRoot, loadFixture, loadManifest } from './fixtures/load.js';
import { type Counts, precisionRecall, wilson } from './score.js';

/** One action a correct pipeline proposes for a fixture. */
export interface ExpectedAction {
  kind: ActionKind;
  ruleId: string;
  date: string | null;
  advice?: RetentionAdvice;
  /** Words the title must contain, case-insensitively. */
  titleIncludes?: string[];
}

/** The authored expectations file. */
interface ExpectedFile {
  asOf: string;
  fixtures: Record<string, ExpectedAction[]>;
}

const KINDS: readonly ActionKind[] = ['attention_flag', 'todo', 'expiry_alert', 'retention_advice'];

const zero = (): Counts => ({ tp: 0, fp: 0, fn: 0, tn: 0 });

function matches(item: ActionItem, expected: ExpectedAction): boolean {
  if (item.kind !== expected.kind || item.ruleId !== expected.ruleId) return false;
  if (item.date !== expected.date) return false;
  if ((item.advice ?? undefined) !== expected.advice) return false;
  const title = item.title.toLowerCase();
  return (expected.titleIncludes ?? []).every((w) => title.includes(w.toLowerCase()));
}

/** One fixture's action score. */
export interface ActionScore {
  counts: Counts;
  perKind: Record<ActionKind, Counts>;
  /** Planned items no expectation matched, for triage. */
  unexpected: ActionItem[];
  /** Expectations no planned item matched, for triage. */
  missed: ExpectedAction[];
}

/**
 * Match planned items to expected ones, one to one, in order.
 *
 * Failure modes: none; pure. A planned item that matches nothing is a false
 * positive, an expectation nothing matched is a false negative, both
 * attributed to their own kind.
 */
export function scoreActions(
  planned: readonly ActionItem[],
  expected: readonly ExpectedAction[],
): ActionScore {
  const perKind = Object.fromEntries(KINDS.map((k) => [k, zero()])) as Record<ActionKind, Counts>;
  const open = [...expected];
  const unexpected: ActionItem[] = [];
  for (const item of planned) {
    const i = open.findIndex((e) => matches(item, e));
    if (i === -1) {
      unexpected.push(item);
      perKind[item.kind].fp += 1;
    } else {
      open.splice(i, 1);
      perKind[item.kind].tp += 1;
    }
  }
  for (const miss of open) perKind[miss.kind].fn += 1;
  const counts = zero();
  for (const c of Object.values(perKind)) {
    counts.tp += c.tp;
    counts.fp += c.fp;
    counts.fn += c.fn;
  }
  return { counts, perKind, unexpected, missed: open };
}

/** Counts with their precision and recall. */
export interface ActionAggregate {
  counts: Counts;
  precision: ReturnType<typeof precisionRecall>['precision'];
  recall: ReturnType<typeof precisionRecall>['recall'];
  recallInterval: ReturnType<typeof wilson>;
}

function aggregate(counts: Counts): ActionAggregate {
  const pr = precisionRecall(counts);
  return {
    counts,
    precision: pr.precision,
    recall: pr.recall,
    recallInterval: wilson(counts.tp, counts.tp + counts.fn),
  };
}

/** The full action eval report. */
export interface ActionEvalReport {
  model: string;
  asOf: string;
  fixtureCount: number;
  overall: ActionAggregate;
  perKind: Array<{ kind: ActionKind } & ActionAggregate>;
  perFixture: Array<{ id: string } & ActionScore>;
}

/**
 * Run the action eval over every committed fixture.
 *
 * Failure modes: rejects if a fixture or the expectations file cannot be
 * read, if a fixture has no expectations entry (a new fixture must be labeled
 * before it counts), or (in replay) if a recording is missing.
 */
export async function runActionEval(
  provider: ModelProvider,
  options: { model: string },
): Promise<ActionEvalReport> {
  const expectations = JSON.parse(
    await readFile(join(fixturesRoot(), 'expected-actions.json'), 'utf8'),
  ) as ExpectedFile;
  const manifest = await loadManifest();
  const perFixture: Array<{ id: string } & ActionScore> = [];
  const totals = Object.fromEntries(KINDS.map((k) => [k, zero()])) as Record<ActionKind, Counts>;

  for (const entry of manifest.fixtures) {
    const expected = expectations.fixtures[entry.id];
    if (!expected) throw new Error(`No expected actions for fixture ${entry.id}.`);
    const fixture = await loadFixture(entry);
    const result = await extract(provider, { images: [fixture.imageBase64], model: options.model });
    const queue = planActions(
      {
        scanned: [fixture.id],
        skipped: [],
        classifierError: null,
        items: [
          {
            file: fixture.id,
            contentHash: fixture.id,
            result,
            reconciliation: reconcileType(result.document?.type ?? null, null),
          },
        ],
      },
      { today: expectations.asOf },
    );
    const score = scoreActions(queue.items, expected);
    perFixture.push({ id: fixture.id, ...score });
    for (const kind of KINDS) {
      totals[kind].tp += score.perKind[kind].tp;
      totals[kind].fp += score.perKind[kind].fp;
      totals[kind].fn += score.perKind[kind].fn;
    }
  }

  const overall = zero();
  for (const c of Object.values(totals)) {
    overall.tp += c.tp;
    overall.fp += c.fp;
    overall.fn += c.fn;
  }
  return {
    model: options.model,
    asOf: expectations.asOf,
    fixtureCount: perFixture.length,
    overall: aggregate(overall),
    perKind: KINDS.map((kind) => ({ kind, ...aggregate(totals[kind]) })),
    perFixture,
  };
}
