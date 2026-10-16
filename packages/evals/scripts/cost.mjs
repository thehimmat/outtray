// Generate the cost dashboard (docs/evals/cost-dashboard.md and
// fixtures/cost.json, Phase 4). Replays every fixture's committed extraction
// and breaks down the time the dev machine reported for it when it was
// recorded. Needs no model, so it runs anywhere; CI replays the same thing and
// fails if the numbers drift from the committed snapshot.
//
// Usage: pnpm eval:cost

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCostReport, summarize } from '../dist/cost.js';
import { RecordingProvider } from '../dist/recording-provider.js';

const here = dirname(fileURLToPath(import.meta.url));
const evalsRoot = join(here, '..');
const snapshotPath = join(evalsRoot, 'fixtures', 'cost.json');
const mdPath = join(evalsRoot, '..', '..', 'docs', 'evals', 'cost-dashboard.md');

const provider = new RecordingProvider({ dir: join(evalsRoot, 'recordings'), mode: 'replay' });
const rows = await runCostReport(provider, { model: 'qwen3-vl:2b' });
const summary = summarize(rows);
writeFileSync(snapshotPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`);

const s = (ms) => (ms === null ? '-' : (ms / 1000).toFixed(1));
const share = (part, whole) => (part === null ? '-' : `${Math.round((part / whole) * 100)}%`);
const table = rows
  .map(
    (r) =>
      `| ${r.id} | ${s(r.loadMs)} | ${s(r.prefillMs)} | ${s(r.generateMs)} | ${s(r.totalMs)} | ${share(r.prefillMs, r.totalMs)} | ${r.promptTokens ?? '-'} | ${r.genTokens ?? '-'} |`,
  )
  .join('\n');
const m = summary.medianMs;
const rates = rows
  .filter((r) => r.prefillMs && r.promptTokens)
  .map((r) => r.promptTokens / (r.prefillMs / 1000))
  .sort((a, b) => a - b);
const prefillRate = Math.round(rates[Math.floor(rates.length / 2)] ?? 0);
const gitSha = execSync('git rev-parse HEAD').toString().trim().slice(0, 12);

const md = `# Cost dashboard

What one extraction costs on the dev machine (a 2022 MacBook Air, 8 GB),
from the timings Ollama reported when each fixture's extraction was
recorded. Load and generating are reported by the runtime; **prefill**
(reading the prompt and the page image) is the rest of the wall time, taken
by difference. Regenerate with \`pnpm eval:cost\`; CI replays it and fails on
drift.

Generated at commit \`${gitSha}\` over ${summary.calls} fixture extractions with \`qwen3-vl:2b\`.

## Headline

| | Median (s) |
| --- | --- |
| Model load | ${s(m.load)} |
| Prefill (prompt and image) | ${s(m.prefill)} |
| Generating the answer | ${s(m.generate)} |
| **Total per document** | **${s(m.total)}** |

- **Prefill is ${Math.round(summary.prefillShare * 100)}% of all the time.** The model writes about
  100 tokens at roughly 43 tokens per second, a couple of seconds; the rest
  is reading a prompt of about 3,300 tokens, most of them the page image,
  at a median of about ${prefillRate} prompt tokens per second (see below:
  that rate is far below what the memory spike measured).
- Slowest call: ${summary.slowest.id}, ${s(summary.slowest.totalMs)} s.

## Per fixture

| Fixture | Load (s) | Prefill (s) | Generate (s) | Total (s) | Prefill share | Prompt tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
${table}

## What this means

- **Reading the input is the cost, not writing the answer.** Generating
  takes about 2 s; prefill takes the rest.
- **The prefill rate is the open question.** The memory spike measured this
  same model reading its prompt at about 1,830 tokens per second, warm and
  fully on the GPU (\`docs/evals/model-memory-spike.md\`). These recordings
  read at about ${prefillRate}. The fixtures (1632x2000) have four times the
  spike page's pixels, which explains about three times the tokens but not a
  rate about 15 times slower. The likeliest cause is the larger context
  spilling off the GPU, as the 4b model did in the spike; contention at
  recording time is the other candidate. #152 measures it on the Air.
- **Either way, the levers are on the input side.** Keep the context on the
  GPU (a smaller image, a smaller context, flash attention), or send less
  image by reading text with the OCR arm (#8). A faster decoder would save
  about 2 s.
- **The incremental scan (ADR-0012) already removes the cost for unchanged
  documents**: they make no model call at all on the next scan.

## Caveats

- **One run per fixture, recorded once.** No noise floor yet (the
  methodology asks for 5 live runs); the machine's load at recording time is
  not known, and the spike found heavy swap on this machine is normal.
- **Model load appears once.** Calls after the first find the model resident;
  a cold start shows as one call's load time.
- **Prefill is by difference**, so it includes any runtime overhead outside
  load and generating. Ollama's own \`prompt_eval_duration\` is not recorded
  yet; recording it would make this a measured figure (#150).
- **Ten synthetic single-page fixtures.** Real multi-page documents cost
  proportionally more.
`;
writeFileSync(mdPath, md);
process.stdout.write(
  `Cost: median ${s(m.total)} s per document, prefill ${Math.round(summary.prefillShare * 100)}% of time\nwrote ${snapshotPath}\nwrote ${mdPath}\n`,
);
