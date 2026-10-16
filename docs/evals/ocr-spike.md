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
- **Ten clean synthetic pages.** Skew, noise, low contrast, multi-page PDFs
  and handwriting are the cases that matter and are not in the fixture set.

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

Filed as issues: `RecognizeDocumentsRequest` (macOS 26 structure), the
pipeline wiring (OCR text into classify-first), timing on the Air, and
noisy-scan fixtures.
