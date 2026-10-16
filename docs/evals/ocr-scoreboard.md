# OCR scoreboard

How much of each fixture the Apple Vision OCR arm reads (issue #8, ADR-0002),
from recordings of the `outtray-ocr` sidecar (`packages/ocr-vision`).
Regenerate with `pnpm eval:ocr`; CI replays it and fails on drift, and the
macOS CI job runs the sidecar live and fails if a field it used to read is
missed.

Generated at commit `e3aabd00998a` from recordings made on macOS 26.6.2 (arm64),
engine `vision-recognize-text` revision 3.

## Headline

| | |
| --- | --- |
| Field recall (labelled value present in the OCR text) | **36/36 (100%)** |
| Word recall (rendered words present in the OCR text) | 373/375 (99%) |
| Median recognition time per page | 2005 ms |

## Per fixture

| Fixture | Fields | Words | Lines | Min confidence | ms | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| bill-001 | 4/4 | 100% | 14 | 1 | 2123 | - |
| receipt-001 | 3/3 | 97% | 13 | 1 | 1963 | - |
| letter-001 | 4/4 | 100% | 11 | 1 | 2102 | - |
| id_document-001 | 4/4 | 100% | 10 | 1 | 2483 | - |
| policy-001 | 3/3 | 100% | 10 | 1 | 1261 | - |
| bill-002 | 4/4 | 100% | 14 | 1 | 2000 | - |
| receipt-002 | 3/3 | 97% | 13 | 1 | 1889 | - |
| letter-002 | 4/4 | 100% | 11 | 1 | 2409 | - |
| id_document-002 | 4/4 | 100% | 10 | 1 | 2011 | - |
| policy-002 | 3/3 | 100% | 10 | 1 | 1160 | - |

## Missed fields

None.

## How to read this

- **Field recall is an upper bound** for anything that reads this text: a
  field the OCR did not read correctly cannot be extracted from it. It is
  not an extraction score; nothing here assigns values to fields.
- **Word recall** is a multiset match of whitespace-separated words, case-
  and edge-punctuation-insensitive. It ignores order and does not count
  extra words, so it measures what was read, not layout.
- **Timing is the sidecar's own** (image decode excluded), on the machine
  that recorded it. CI runners are not the dev machine; see
  `docs/evals/ocr-spike.md` for what was measured where.

## Caveats

- Ten synthetic, clean, single-page renders. Real scans (skew, noise, low
  contrast, handwriting) are the case that matters and are not measured.
- `coverage_summary` is free text and not scored.
