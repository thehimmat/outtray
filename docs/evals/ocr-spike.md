# Apple Vision OCR spike (issue #8)

Can the OCR arm ADR-0002 calls primary be built as a small Swift sidecar
with a Zod-validated contract, and is its text good enough to build on?
Yes, on the evidence below, with caveats about where it was measured.

## What was built

- `packages/ocr-vision`: a SwiftPM executable, `outtray-ocr <image>`, that
  runs `VNRecognizeTextRequest` (accurate) and prints one `ocr-v1` JSON
  object: lines of text, a confidence per line, and a box normalized to the
  page with the origin at the top left, in reading order (rows by vertical
  overlap, then left to right).
- `packages/core/src/ocr-contract.ts`: the strict Zod schema and
  `parseOcrOutput`, host-neutral. `packages/core/src/ocr-vision.ts`: the Node
  runner (`VisionOcr`), which refuses off macOS without spawning anything and
  maps a missing binary, a failed run and a contract mismatch to three
  distinct errors.
- `pnpm eval:ocr`: scores recordings of the sidecar against the fixtures'
  labels and rendered HTML (`docs/evals/ocr-scoreboard.md`).

## Numbers

Measured on a GitHub Actions `macos-latest` runner (macOS 26.6.2, arm64,
virtualized Apple silicon), not on the dev machine.

| | Vision OCR | VLM extraction (`qwen3-vl:2b`, the Air) |
| --- | --- | --- |
| Labelled field values present in the output | 36/36 (text only) | 77% recall, values assigned to fields (`scoreboard.md`) |
| Rendered words read | 373/375 | not measured |
| Median time per page | 2.0 s | 31.8 s (`cost-dashboard.md`) |
| Peak memory | 207 MB footprint, 239 MB RSS (one page, `/usr/bin/time -l`) | about 1.85 GB (#127) |

The two missed words are the same glyph on both receipts: a middle dot
read as a bullet.

## What this does and does not show

- **The text is all there.** Every labelled value, identifiers included
  (`D8923829`, `POL-804220`), appears verbatim in the OCR text of every
  fixture. A text-based classifier or extractor reading this would not be
  limited by OCR on these fixtures.
- **It is not an extraction score.** The OCR arm reads; it does not decide
  which number is the amount due. Field recall here is an upper bound for
  any stage that reads this text.
- **Confidence carries no information here.** Vision reported 1.0 for every
  line on these clean renders. Whether it separates good from bad lines on
  real scans is unmeasured, and cross-arm confidence (ADR-0002) should not
  lean on it until it is.
- **Not measured on the Air.** The runner is virtualized and logged that it
  has no M2 scaler driver, so the Neural Engine may not be in use; the Air
  could be faster. The cost on the Air is part of the next on-device
  session (#149 or its successor).
- **Synthetic pages.** The degraded copies (below) are simulated; real
  scans, multi-page PDFs and handwriting are not in the fixture set.

## Degraded pages (#160)

Two simulated degradations of every fixture (`fixtures/degraded`, parameters
in its manifest), each read with Vision's language correction on and off.
Full table in `docs/evals/ocr-scoreboard.md`.

| Pages | Fields | Identifiers exact | Words |
| --- | --- | --- | --- |
| clean | 36/36 | 4/4 | 373/375 |
| scan (skew 1.5 deg, blur, noise, JPEG 55) | 36/36 | 4/4 | 373/375 |
| harsh (half resolution, skew 3.5 deg, uneven light, heavy noise, JPEG 35) | 8/36 | 0/4 | 45/375 |

What this shows:

- **A flatbed scan costs nothing.** Every field and identifier survives.
- **The harsh pages fail by omission, not misreading.** Vision finds the
  large headings and amounts and does not detect the body text at all. The
  failure is a cliff, not a slope; where it starts between the two levels is
  unmeasured.
- **Confidence does not flag misreads.** "Harbor Casuaily" and "orate of
  Calfornia" both came back at confidence 1.0. Vision's line confidence
  cannot be the OCR arm's contribution to field confidence (ADR-0002's
  cross-arm agreement); agreement with the VLM has to be measured on the
  text itself.
- **Language correction barely matters.** It changed one field on one page
  (a sender on a harsh page, read only with correction off) and never an
  identifier. Default stays on; no reason found to change it.
- **Reading order** now pairs a label with a taller value on its baseline
  and keeps a tall heading from swallowing the lines beside it (XCTest in
  `packages/ocr-vision/Tests`).

## Telling a page was not read (#163)

`assessReadability` (core) judges each page from the OCR result alone: fewer
than 130 characters, or a median line height above 0.021 of the page (only
large text found), means unreadable. On the 30 recorded pages it flags all
10 where the OCR missed over a quarter of the fields and none of the other
20 (scoreboard section "Readability detector"). The thresholds sit midway
in gaps measured on these same pages, so this shows the signal separates
them, not that it generalizes. It leans toward flagging: a false alarm costs
one VLM call, a miss loses fields silently.

## What it unlocks

- **Classify-first routing (ADR-0009 section 1).** The classifier can run on
  OCR text before the VLM, the order ADR-0009 described and had to invert
  because no text existed before extraction.
- **Identifier tokenization of OCR text (#97).** Misses can be reported once
  text has an expected location, which OCR boxes provide.
- **A cheaper first pass.** At about a tenth of the VLM's time and memory
  per page, OCR text could decide which pages need the VLM at all. That is
  a claim to measure, not yet a result.

## Follow-ups

- #159: OCR text into `scan`, classify-first routing (ADR-0009 section 1).
- #160: degraded pages, language correction and reading order (done, below);
  `RecognizeDocumentsRequest` and timing on the Air remain.
