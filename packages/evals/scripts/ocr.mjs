// OCR arm eval (issue #8). How much of each fixture the Apple Vision sidecar
// reads: field recall against the labels, word recall against the rendered
// HTML. Modes:
//   replay (default) - score the committed recordings; runs anywhere. Writes
//                      fixtures/ocr.json and docs/evals/ocr-scoreboard.md.
//   record           - macOS: run the sidecar, write recordings, then replay.
//   check            - macOS (CI): run the sidecar live, fail if any field the
//                      committed snapshot found is now missed, and print each
//                      result as an OCR-RECORDING line so a run's output can
//                      be committed from a machine without macOS.
//
// Usage: pnpm eval:ocr [replay|record|check] [--binary path/to/outtray-ocr]

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VisionOcr } from '@outtray/core/node';
import { ocrRecordingsDir, replayRecognizer, runOcrReport, summarizeOcr } from '../dist/index.js';

const MODE = process.argv[2] ?? 'replay';
const flag = process.argv.indexOf('--binary');
const binary =
  flag > 0
    ? process.argv[flag + 1]
    : join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'ocr-vision',
        '.build',
        'release',
        'outtray-ocr',
      );

const here = dirname(fileURLToPath(import.meta.url));
const evalsRoot = join(here, '..');
const snapshotPath = join(evalsRoot, 'fixtures', 'ocr.json');
const mdPath = join(evalsRoot, '..', '..', 'docs', 'evals', 'ocr-scoreboard.md');
const recordings = ocrRecordingsDir();

const host = () =>
  process.platform === 'darwin'
    ? `macOS ${execSync('sw_vers -productVersion').toString().trim()} (${process.arch})`
    : process.platform;

function liveRecognizer() {
  const ocr = new VisionOcr({ binary });
  return (_entry, pngPath) => ocr.recognize(pngPath);
}

if (MODE === 'record' || MODE === 'check') {
  const { rows, results } = await runOcrReport(liveRecognizer());
  const summary = summarizeOcr(rows);
  const manifest = JSON.parse(readFileSync(join(evalsRoot, 'fixtures', 'manifest.json'), 'utf8'));
  const recordingOf = (entry) => ({
    fixture: entry.id,
    pngSha256: entry.files.png.sha256,
    host: host(),
    result: results.get(entry.id),
  });
  if (MODE === 'record') {
    mkdirSync(recordings, { recursive: true });
    for (const entry of manifest.fixtures) {
      writeFileSync(
        join(recordings, `${entry.id}.json`),
        `${JSON.stringify(recordingOf(entry), null, 2)}\n`,
      );
    }
  } else {
    for (const entry of manifest.fixtures) {
      process.stdout.write(`OCR-RECORDING ${JSON.stringify(recordingOf(entry))}\n`);
    }
    process.stdout.write(
      `OCR live on ${host()}: fields ${summary.fieldsFound}/${summary.fieldsTotal}, ` +
        `words ${summary.wordsFound}/${summary.wordsTotal}, median ${summary.medianMs} ms\n`,
    );
    for (const m of summary.misses) {
      process.stdout.write(`  missed ${m.id} ${m.field}: ${JSON.stringify(m.expected)}\n`);
    }
    if (existsSync(snapshotPath)) {
      const before = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      const missedNow = new Set(summary.misses.map((m) => `${m.id}/${m.field}`));
      const regressed = before.rows.flatMap((r) =>
        r.fields
          .filter((f) => f.found && missedNow.has(`${r.id}/${f.field}`))
          .map((f) => `${r.id}/${f.field}`),
      );
      if (regressed.length > 0) {
        process.stderr.write(`OCR regressed against fixtures/ocr.json: ${regressed.join(', ')}\n`);
        process.exit(1);
      }
    }
    process.exit(0);
  }
}

// replay (and the tail of record): the committed numbers.
const { rows } = await runOcrReport(replayRecognizer(recordings));
const summary = summarizeOcr(rows);
writeFileSync(snapshotPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`);

const firstRecording = JSON.parse(readFileSync(join(recordings, `${rows[0].id}.json`), 'utf8'));
const pct = (k, n) => (n === 0 ? '-' : `${Math.round((k / n) * 100)}%`);
const table = rows
  .map((r) => {
    const found = r.fields.filter((f) => f.found).length;
    const missed = r.fields.filter((f) => !f.found).map((f) => f.field);
    return `| ${r.id} | ${found}/${r.fields.length} | ${pct(r.words.found, r.words.total)} | ${r.lines} | ${r.minConfidence ?? '-'} | ${Math.round(r.elapsedMs)} | ${missed.join(', ') || '-'} |`;
  })
  .join('\n');
const misses =
  summary.misses.length === 0
    ? 'None.'
    : summary.misses.map((m) => `- ${m.id} \`${m.field}\`: expected \`${m.expected}\``).join('\n');
const gitSha = execSync('git rev-parse HEAD').toString().trim().slice(0, 12);

const md = `# OCR scoreboard

How much of each fixture the Apple Vision OCR arm reads (issue #8, ADR-0002),
from recordings of the \`outtray-ocr\` sidecar (\`packages/ocr-vision\`).
Regenerate with \`pnpm eval:ocr\`; CI replays it and fails on drift, and the
macOS CI job runs the sidecar live and fails if a field it used to read is
missed.

Generated at commit \`${gitSha}\` from recordings made on ${firstRecording.host},
engine \`${firstRecording.result.engine}\` revision ${firstRecording.result.engineRevision}.

## Headline

| | |
| --- | --- |
| Field recall (labelled value present in the OCR text) | **${summary.fieldsFound}/${summary.fieldsTotal} (${pct(summary.fieldsFound, summary.fieldsTotal)})** |
| Word recall (rendered words present in the OCR text) | ${summary.wordsFound}/${summary.wordsTotal} (${pct(summary.wordsFound, summary.wordsTotal)}) |
| Median recognition time per page | ${Math.round(summary.medianMs)} ms |

## Per fixture

| Fixture | Fields | Words | Lines | Min confidence | ms | Missed |
| --- | --- | --- | --- | --- | --- | --- |
${table}

## Missed fields

${misses}

## How to read this

- **Field recall is an upper bound** for anything that reads this text: a
  field the OCR did not read correctly cannot be extracted from it. It is
  not an extraction score; nothing here assigns values to fields.
- **Word recall** is a multiset match of whitespace-separated words, case-
  and edge-punctuation-insensitive. It ignores order and does not count
  extra words, so it measures what was read, not layout.
- **Timing is the sidecar's own** (image decode excluded), on the machine
  that recorded it. CI runners are not the dev machine; see
  \`docs/evals/ocr-spike.md\` for what was measured where.

## Caveats

- Ten synthetic, clean, single-page renders. Real scans (skew, noise, low
  contrast, handwriting) are the case that matters and are not measured.
- \`coverage_summary\` is free text and not scored.
`;
writeFileSync(mdPath, md);
process.stdout.write(
  `OCR: fields ${summary.fieldsFound}/${summary.fieldsTotal}, words ${summary.wordsFound}/${summary.wordsTotal}\nwrote ${snapshotPath}\nwrote ${mdPath}\n`,
);
