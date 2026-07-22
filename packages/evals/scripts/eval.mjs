// Eval driver. Modes:
//   record  - run live qwen3-vl:2b, write recordings, refresh the scoreboard
//   live    - run live qwen3-vl:2b without touching recordings or scoreboard
//   replay  - replay committed recordings (what CI does), print the numbers
//
// Usage: pnpm build && node packages/evals/scripts/eval.mjs <mode>

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACTION_PROMPT, OllamaProvider, PROMPT_VERSION } from '@outtray/core';
import { RecordingProvider } from '../dist/recording-provider.js';
import { runEval } from '../dist/run-eval.js';

const MODE = process.argv[2] ?? 'replay';
const MODEL = 'qwen3-vl:2b';

const here = dirname(fileURLToPath(import.meta.url));
const evalsRoot = join(here, '..');
const recordingsDir = join(evalsRoot, 'recordings');
const scoreboardJson = join(evalsRoot, 'fixtures', 'scoreboard.json');
const scoreboardMd = join(evalsRoot, '..', '..', 'docs', 'evals', 'scoreboard.md');

function providerFor(mode) {
  if (mode === 'live') return new OllamaProvider();
  if (mode === 'record') {
    return new RecordingProvider({
      inner: new OllamaProvider(),
      dir: recordingsDir,
      mode: 'record',
    });
  }
  return new RecordingProvider({ dir: recordingsDir, mode: 'replay' });
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const pct = (p) => (p.rate === null ? '-' : `${(p.rate * 100).toFixed(0)}%`);
const ci = (i) =>
  i.low === null ? '' : ` [${(i.low * 100).toFixed(0)}-${(i.high * 100).toFixed(0)}]`;

const report = await runEval(providerFor(MODE), { model: MODEL });

// Console summary.
process.stdout.write(`\nEval (${MODE}) model=${report.model} fixtures=${report.fixtureCount}\n`);
for (const t of report.perType) {
  process.stdout.write(
    `  ${t.type.padEnd(12)} P ${t.precision.k}/${t.precision.n} (${pct(t.precision)})  R ${t.recall.k}/${t.recall.n} (${pct(t.recall)})\n`,
  );
}
const o = report.overall;
process.stdout.write(
  `  ${'OVERALL'.padEnd(12)} P ${o.precision.k}/${o.precision.n} (${pct(o.precision)})  R ${o.recall.k}/${o.recall.n} (${pct(o.recall)})\n`,
);

if (MODE === 'replay' || MODE === 'live') process.exit(0);

// record mode: write the scoreboard (numbers + stamps).
const manifest = readFileSync(join(evalsRoot, 'fixtures', 'manifest.json'), 'utf8');
const gitSha = execSync('git rev-parse HEAD').toString().trim();
const stamps = {
  model: MODEL,
  promptHash: sha(`${PROMPT_VERSION}\n${EXTRACTION_PROMPT}`).slice(0, 12),
  fixtureSetHash: sha(manifest).slice(0, 12),
  gitSha: gitSha.slice(0, 12),
};

const snapshot = {
  stamps,
  overall: o.counts,
  perType: report.perType.map((t) => ({ type: t.type, counts: t.counts })),
};
writeFileSync(scoreboardJson, `${JSON.stringify(snapshot, null, 2)}\n`);

const rows = report.perType
  .map(
    (t) =>
      `| ${t.type} | ${t.precision.k}/${t.precision.n} (${pct(t.precision)}) | ${t.recall.k}/${t.recall.n} (${pct(t.recall)})${ci(t.recallInterval)} |`,
  )
  .join('\n');
const md = `# Scoreboard

Append-only history of extraction quality on the committed synthetic fixture
set. Numbers are per-field precision/recall as raw counts (METHODOLOGY.md);
recall shows a 95% Wilson interval. Regenerate with \`pnpm eval:record\`.

Stamps: model \`${stamps.model}\`, prompt \`${stamps.promptHash}\`, fixtures \`${stamps.fixtureSetHash}\`, commit \`${stamps.gitSha}\`.

| Document type | Precision | Recall (95% CI) |
| --- | --- | --- |
${rows}
| **overall** | **${o.precision.k}/${o.precision.n} (${pct(o.precision)})** | **${o.recall.k}/${o.recall.n} (${pct(o.recall)})${ci(o.recallInterval)}** |

CI replays the committed recordings and recomputes these counts; a mismatch
fails the build with "run pnpm eval:record".
`;
writeFileSync(scoreboardMd, md);
process.stdout.write(
  `\nwrote scoreboard (${report.perFixture.filter((f) => f.valid).length}/${report.fixtureCount} valid extractions)\n`,
);
