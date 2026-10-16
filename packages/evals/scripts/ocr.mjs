// OCR arm eval (#8, #160). How much of each page the Apple Vision sidecar
// reads, on the clean fixtures and on degraded copies (fixtures/degraded), with
// Vision's language correction on (`default`) and off. Modes:
//   replay (default) - score the committed recordings; runs anywhere. Writes
//                      fixtures/ocr.json and docs/evals/ocr-scoreboard.md.
//   record           - macOS: run the sidecar on every page in every variant,
//                      write recordings whose reading changed, then replay.
//                      Writes nothing if a field the snapshot read is now
//                      missed. The `ocr` CI job runs this on a PR and commits
//                      the result to the PR branch.
//   check            - macOS: run the sidecar live and fail if a field the
//                      committed snapshot read is now missed.
//
// Usage: pnpm eval:ocr [replay|record|check] [--binary path/to/outtray-ocr]

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VisionOcr } from '@outtray/core/node';
import {
  loadOcrPages,
  OCR_LEVELS,
  OCR_VARIANTS,
  ocrRecordingsDir,
  recordingPath,
  replayRecognizer,
  runOcrReport,
  summarizeByLevel,
} from '../dist/index.js';

const MODE = process.argv[2] ?? 'replay';
const flag = process.argv.indexOf('--binary');
const here = dirname(fileURLToPath(import.meta.url));
const binary =
  flag > 0
    ? process.argv[flag + 1]
    : join(here, '..', '..', 'ocr-vision', '.build', 'release', 'outtray-ocr');
const evalsRoot = join(here, '..');
const snapshotPath = join(evalsRoot, 'fixtures', 'ocr.json');
const mdPath = join(evalsRoot, '..', '..', 'docs', 'evals', 'ocr-scoreboard.md');
const recordings = ocrRecordingsDir();

function liveRecognizer(variant) {
  const ocr = new VisionOcr({ binary, languageCorrection: variant === 'default' });
  return (_page, imagePath) => ocr.recognize(imagePath);
}

if (MODE === 'record' || MODE === 'check') {
  const pages = await loadOcrPages();
  const host =
    process.platform === 'darwin'
      ? `macOS ${execSync('sw_vers -productVersion').toString().trim()} (${process.arch})`
      : process.platform;
  const before = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : null;
  const regressed = [];
  const live = new Map();
  for (const variant of OCR_VARIANTS) {
    const { rows, results } = await runOcrReport(liveRecognizer(variant), pages);
    const byLevel = summarizeByLevel(rows);
    for (const level of OCR_LEVELS) {
      const s = byLevel[level];
      if (!s) continue;
      process.stdout.write(
        `${variant} ${level}: fields ${s.fieldsFound}/${s.fieldsTotal}, identifiers ` +
          `${s.identifiersFound}/${s.identifiersTotal}, words ${s.wordsFound}/${s.wordsTotal}, ` +
          `median ${Math.round(s.medianMs)} ms\n`,
      );
    }
    const missedNow = new Set(
      rows.flatMap((r) => r.fields.filter((f) => !f.found).map((f) => `${r.id}/${f.field}`)),
    );
    for (const r of before?.variants?.[variant]?.rows ?? []) {
      for (const f of r.fields) {
        const key = `${r.id}/${f.field}`;
        if (f.found && missedNow.has(key)) regressed.push(`${variant}: ${key}`);
      }
    }
    live.set(variant, results);
  }
  if (regressed.length > 0) {
    process.stderr.write(`OCR regressed against fixtures/ocr.json:\n  ${regressed.join('\n  ')}\n`);
    process.exitCode = 1;
  } else if (MODE === 'record') {
    for (const [variant, results] of live) {
      for (const page of pages) {
        const path = join(recordings, recordingPath(variant, page.id));
        const result = results.get(page.id);
        if (sameReading(path, page, result)) continue;
        mkdirSync(dirname(path), { recursive: true });
        const recording = { page: page.id, variant, imageSha256: page.imageSha256, host, result };
        writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
      }
    }
  }
}

// check never rewrites the snapshot, and nothing is written over a regression;
// both set exitCode and let stdout drain rather than calling process.exit.
if (MODE === 'replay' || (MODE === 'record' && process.exitCode !== 1)) await replay();

/**
 * True when the committed recording at `path` is of the same image and reads
 * the same text in the same places. Timing and host differ on every run, so a
 * recording is only rewritten when what Vision read changed.
 */
function sameReading(path, page, result) {
  if (!existsSync(path)) return false;
  const old = JSON.parse(readFileSync(path, 'utf8'));
  const strip = (r) => JSON.stringify({ ...r, elapsedMs: 0 });
  return old.imageSha256 === page.imageSha256 && strip(old.result) === strip(result);
}

async function replay() {
  const variants = {};
  for (const variant of OCR_VARIANTS) {
    const { rows } = await runOcrReport(replayRecognizer(variant));
    variants[variant] = { byLevel: summarizeByLevel(rows), rows };
  }
  writeFileSync(snapshotPath, `${JSON.stringify({ variants }, null, 2)}\n`);
  writeFileSync(mdPath, markdown(variants));
  const d = variants.default.byLevel;
  process.stdout.write(
    `OCR (default): ${OCR_LEVELS.map((l) => `${l} ${d[l].fieldsFound}/${d[l].fieldsTotal}`).join(', ')}\nwrote ${snapshotPath}\nwrote ${mdPath}\n`,
  );
}

function markdown(variants) {
  const first = JSON.parse(
    readFileSync(join(recordings, recordingPath('default', variants.default.rows[0].id)), 'utf8'),
  );
  const pct = (k, n) => (n === 0 ? '-' : `${Math.round((k / n) * 100)}%`);
  const frac = (k, n) => `${k}/${n} (${pct(k, n)})`;
  const headline = OCR_VARIANTS.flatMap((v) =>
    OCR_LEVELS.map((l) => {
      const s = variants[v].byLevel[l];
      return `| ${l} | ${v} | ${frac(s.fieldsFound, s.fieldsTotal)} | ${frac(s.identifiersFound, s.identifiersTotal)} | ${frac(s.wordsFound, s.wordsTotal)} | ${Math.round(s.medianMs)} |`;
    }),
  ).join('\n');
  const perPage = (v) =>
    variants[v].rows
      .map((r) => {
        const found = r.fields.filter((f) => f.found).length;
        const missed = r.fields.filter((f) => !f.found).map((f) => f.field);
        return `| ${r.id} | ${found}/${r.fields.length} | ${pct(r.words.found, r.words.total)} | ${r.lines} | ${r.minConfidence ?? '-'} | ${Math.round(r.elapsedMs)} | ${missed.join(', ') || '-'} |`;
      })
      .join('\n');
  // Where the two variants disagree on a field.
  const off = new Map(
    variants['no-language-correction'].rows.map((r) => [
      r.id,
      new Map(r.fields.map((f) => [f.field, f.found])),
    ]),
  );
  const diffs = variants.default.rows.flatMap((r) =>
    r.fields
      .filter((f) => off.get(r.id)?.get(f.field) !== f.found)
      .map(
        (f) =>
          `- ${r.id} \`${f.field}\` (\`${f.expected}\`): ${f.found ? 'read with correction, missed without' : 'missed with correction, read without'}`,
      ),
  );
  const gitSha = execSync('git rev-parse HEAD').toString().trim().slice(0, 12);
  const degraded = JSON.parse(
    readFileSync(join(evalsRoot, 'fixtures', 'degraded', 'manifest.json'), 'utf8'),
  );
  const levels = Object.entries(degraded.levels)
    .map(([name, p]) => `- **${name}**: ${p.description}`)
    .join('\n');

  return `# OCR scoreboard

How much of each page the Apple Vision OCR arm reads (#8, #160, ADR-0002),
from recordings of the \`outtray-ocr\` sidecar (\`packages/ocr-vision\`).
Regenerate with \`pnpm eval:ocr\`; CI replays it and fails on drift. The
\`ocr\` CI job runs the sidecar live on macOS, fails if a field it used to
read is missed, and records and commits new recordings when the sidecar or
the pages change.

Generated at commit \`${gitSha}\` from recordings made on ${first.host},
engine \`${first.result.engine}\` revision ${first.result.engineRevision}.

## Pages

The ten clean fixture renders, plus two degraded copies of each
(\`fixtures/degraded\`, made by \`scripts/degrade-fixtures.py\`), scored against
the same labels:

${levels}

**Variants**: \`default\` runs Vision with language correction on;
\`no-language-correction\` turns it off, since correction can rewrite
identifier-like tokens toward dictionary words.

## Headline

| Pages | Variant | Fields | Identifiers exact | Words | Median ms |
| --- | --- | --- | --- | --- | --- |
${headline}

- **Fields**: the labelled value is present in the OCR text (normalized;
  amounts need a currency sign or cents, text matches on word boundaries).
- **Identifiers exact**: the ID and policy numbers, the values #97 must
  read character for character.
- **Words**: rendered words present in the OCR text, as a multiset.

## Where language correction changes the result

${diffs.length === 0 ? 'Nowhere: both variants read the same fields on every page.' : diffs.join('\n')}

## Per page (default variant)

| Page | Fields | Words | Lines | Min confidence | ms | Missed |
| --- | --- | --- | --- | --- | --- | --- |
${perPage('default')}

## Per page (no language correction)

| Page | Fields | Words | Lines | Min confidence | ms | Missed |
| --- | --- | --- | --- | --- | --- | --- |
${perPage('no-language-correction')}

## How to read this

- **Field recall is an upper bound** for anything that reads this text: a
  field the OCR did not read correctly cannot be extracted from it. It is
  not an extraction score; nothing here assigns values to fields.
- **Word recall** ignores order and does not count extra words, so it
  measures what was read, not layout.
- **Timing is the sidecar's own** (image decode excluded), on the machine
  that recorded it, a CI Mac, not the dev machine
  (\`docs/evals/ocr-spike.md\`).

## Caveats

- Ten synthetic layouts. The degraded copies are simulated (geometric and
  photometric noise), not real scans; handwriting, folds, stamps and
  multi-page PDFs are not covered.
- \`coverage_summary\` is free text and not scored.
`;
}
