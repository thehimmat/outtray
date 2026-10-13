// Generate the action-level scoreboard (docs/evals/action-scoreboard.md and
// fixtures/action-scoreboard.json, issue #64). Replays the committed VLM
// extractions, plans each fixture's action queue with the product planner at
// the expectations file's fixed as-of date, and scores it against the
// authored expected actions. Needs no model, so it runs anywhere; CI replays
// the same thing and fails if the counts drift from the committed snapshot.
//
// Usage: pnpm eval:actions

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runActionEval } from '../dist/action-eval.js';
import { RecordingProvider } from '../dist/recording-provider.js';

const here = dirname(fileURLToPath(import.meta.url));
const evalsRoot = join(here, '..');
const snapshotPath = join(evalsRoot, 'fixtures', 'action-scoreboard.json');
const mdPath = join(evalsRoot, '..', '..', 'docs', 'evals', 'action-scoreboard.md');

const provider = new RecordingProvider({ dir: join(evalsRoot, 'recordings'), mode: 'replay' });
const report = await runActionEval(provider, { model: 'qwen3-vl:2b' });

const pct = (p) => (p.rate === null ? '-' : `${(p.rate * 100).toFixed(0)}%`);
const ci = (i) =>
  i.low === null ? '' : ` [${(i.low * 100).toFixed(0)}-${(i.high * 100).toFixed(0)}]`;
const row = (name, a) =>
  `| ${name} | ${a.precision.k}/${a.precision.n} (${pct(a.precision)}) | ${a.recall.k}/${a.recall.n} (${pct(a.recall)})${ci(a.recallInterval)} |`;

const snapshot = {
  asOf: report.asOf,
  overall: report.overall.counts,
  perKind: Object.fromEntries(report.perKind.map((k) => [k.kind, k.counts])),
};
writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

const describe = (a) =>
  a.kind === 'retention_advice'
    ? `${a.kind} ${a.advice}`
    : `${a.kind} ${a.ruleId}${a.date ? ` ${a.date}` : ''}`;
const triage = report.perFixture
  .filter((f) => f.missed.length > 0 || f.unexpected.length > 0)
  .map((f) => {
    const missed = f.missed.map(describe).join('; ') || '-';
    const extra = f.unexpected.map(describe).join('; ') || '-';
    return `| ${f.id} | ${missed} | ${extra} |`;
  })
  .join('\n');

const gitSha = execSync('git rev-parse HEAD').toString().trim().slice(0, 12);
const md = `# Action scoreboard

Quality of the proposed action queue (ADR-0010), end to end from a recorded
extraction: each fixture's committed \`qwen3-vl:2b\` extraction is planned by
\`planActions\` as of ${report.asOf} and matched one to one against actions
authored from the fixture's ground truth (\`packages/evals/fixtures/expected-actions.json\`).
A match needs the same kind, rule, date and retention advice, and a title
containing the required words. Recall shows a 95% Wilson interval.
Regenerate with \`pnpm eval:actions\`; CI replays it and fails on drift.

Generated at commit \`${gitSha}\` over ${report.fixtureCount} synthetic fixtures.

| Action kind | Precision | Recall (95% CI) |
| --- | --- | --- |
${report.perKind.map((k) => row(k.kind, k)).join('\n')}
| **overall** | **${report.overall.precision.k}/${report.overall.precision.n} (${pct(report.overall.precision)})** | **${report.overall.recall.k}/${report.overall.recall.n} (${pct(report.overall.recall)})${ci(report.overall.recallInterval)}** |

## Where it misses

| Fixture | Expected, not proposed | Proposed, not expected |
| --- | --- | --- |
${triage || '| - | - | - |'}

## Caveats

- **VLM only.** Reconciliation runs with no classifier verdict because
  embeddings are not recorded yet (#52), so a type the extractor gets wrong
  costs its actions here even where the live two-stage pipeline corrects it
  (the classification scoreboard measures that stage on its own).
- **N is small.** Ten synthetic fixtures; intervals are wide and one fixture
  moves a row by double digits.
- **Expectations are authored, not observed.** To-dos are expected only where
  a document asks for something with a date. A model-proposed to-do with no
  counterpart counts against precision even when a person might find it
  useful; that is deliberate, since the queue's value is in not crying wolf.
`;
writeFileSync(mdPath, md);
process.stdout.write(
  `Action eval: P ${report.overall.precision.k}/${report.overall.precision.n}  R ${report.overall.recall.k}/${report.overall.recall.n}\nwrote ${snapshotPath}\nwrote ${mdPath}\n`,
);
