// Generate the classification scoreboard (docs/evals/classification-scoreboard.md).
// Replays the committed VLM extractions and runs the ADR-0009 classifier over
// them with a LIVE embedder; writes the VLM-vs-classifier accuracy table.
//
// Usage: pnpm build && node packages/evals/scripts/classify.mjs
// Requires Ollama with qwen3-vl:2b recordings present and nomic-embed-text pulled.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OllamaEmbeddingProvider } from '@outtray/core';
import { classifyEval } from '../dist/classify-eval.js';
import { RecordingProvider } from '../dist/recording-provider.js';

const here = dirname(fileURLToPath(import.meta.url));
const evalsRoot = join(here, '..');
const out = join(evalsRoot, '..', '..', 'docs', 'evals', 'classification-scoreboard.md');

const model = new RecordingProvider({ dir: join(evalsRoot, 'recordings'), mode: 'replay' });
const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });

const report = await classifyEval(model, embedder, { model: 'qwen3-vl:2b' });

const pct = (a) => (a.n === 0 ? '-' : `${a.k}/${a.n} (${Math.round((a.k / a.n) * 100)}%)`);
const rows = report.perType
  .map((t) => `| ${t.type} | ${pct(t.vlm)} | ${pct(t.classifier)} |`)
  .join('\n');

const md = `# Classification scoreboard

Document-type classification accuracy: the one-shot VLM label vs the ADR-0009
on-device k-NN classifier run over the VLM's extraction text. Measures whether
the cheap classifier corrects the VLM's type errors (issue #37).

Model \`qwen3-vl:2b\` (replayed) + embedder \`nomic-embed-text\` (live). Generated
by \`node packages/evals/scripts/classify.mjs\`. Not yet CI-replayed: embedding
record/replay is a follow-up, so these are dev-run numbers.

| Document type | VLM type accuracy | Classifier accuracy |
| --- | --- | --- |
${rows}
| **overall** | **${pct(report.vlm)}** | **${pct(report.classifier)}** |

The classifier is seeded only (no user corrections yet); personalization from
the ADR-0008 correction loop layers on top.
`;
writeFileSync(out, md);
process.stdout.write(
  `classification: VLM ${pct(report.vlm)}, classifier ${pct(report.classifier)}\n`,
);
for (const r of report.rows) {
  process.stdout.write(`  ${r.id.padEnd(16)} label=${r.label} vlm=${r.vlm} clf=${r.classifier}\n`);
}
