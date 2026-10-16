# OCR scoreboard

How much of each page the Apple Vision OCR arm reads (#8, #160, ADR-0002),
from recordings of the `outtray-ocr` sidecar (`packages/ocr-vision`).
Regenerate with `pnpm eval:ocr`; CI replays it and fails on drift. The
`ocr` CI job runs the sidecar live on macOS, fails if a field it used to
read is missed, and records and commits new recordings when the sidecar or
the pages change.

Generated at commit `0cf57cb2ac9d` from recordings made on macOS 26.6.2 (arm64),
engine `vision-recognize-text` revision 3.

## Pages

The ten clean fixture renders, plus two degraded copies of each
(`fixtures/degraded`, made by `scripts/degrade-fixtures.py`), scored against
the same labels:

- **scan**: Flatbed scan: slight skew, soft focus, sensor noise, JPEG.
- **harsh**: Poor phone photo: half resolution, visible skew, blur, uneven light, washed-out contrast, heavy noise, strong JPEG.

**Variants**: `default` runs Vision with language correction on;
`no-language-correction` turns it off, since correction can rewrite
identifier-like tokens toward dictionary words.

## Headline

| Pages | Variant | Fields | Identifiers exact | Words | Median ms |
| --- | --- | --- | --- | --- | --- |
| clean | default | 36/36 (100%) | 4/4 (100%) | 373/375 (99%) | 1790 |
| scan | default | 36/36 (100%) | 4/4 (100%) | 373/375 (99%) | 1636 |
| harsh | default | 8/36 (22%) | 0/4 (0%) | 45/375 (12%) | 1256 |
| clean | no-language-correction | 36/36 (100%) | 4/4 (100%) | 373/375 (99%) | 1597 |
| scan | no-language-correction | 36/36 (100%) | 4/4 (100%) | 373/375 (99%) | 1577 |
| harsh | no-language-correction | 9/36 (25%) | 0/4 (0%) | 43/375 (11%) | 1198 |

- **Fields**: the labelled value is present in the OCR text (normalized;
  amounts need a currency sign or cents, text matches on word boundaries).
- **Identifiers exact**: the ID and policy numbers, the values #97 must
  read character for character.
- **Words**: rendered words present in the OCR text, as a multiset.

## Where language correction changes the result

- letter-002.harsh `sender` (`Northgate Property Mgmt`): missed with correction, read without

## Per page (default variant)

| Page | Fields | Words | Lines | Min confidence | ms | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| bill-001 | 4/4 | 100% | 14 | 1 | 1844 | - |
| receipt-001 | 3/3 | 97% | 13 | 1 | 1658 | - |
| letter-001 | 4/4 | 100% | 11 | 1 | 1865 | - |
| id_document-001 | 4/4 | 100% | 10 | 1 | 1924 | - |
| policy-001 | 3/3 | 100% | 10 | 1 | 1089 | - |
| bill-002 | 4/4 | 100% | 14 | 1 | 1784 | - |
| receipt-002 | 3/3 | 97% | 13 | 1 | 1614 | - |
| letter-002 | 4/4 | 100% | 11 | 1 | 2201 | - |
| id_document-002 | 4/4 | 100% | 10 | 1 | 1795 | - |
| policy-002 | 3/3 | 100% | 10 | 1 | 1054 | - |
| bill-001.scan | 4/4 | 100% | 14 | 1 | 1952 | - |
| bill-001.harsh | 2/4 | 13% | 4 | 0.3 | 1667 | due_date, late_fee |
| receipt-001.scan | 3/3 | 97% | 13 | 1 | 1765 | - |
| receipt-001.harsh | 2/3 | 16% | 3 | 1 | 1303 | purchased_at |
| letter-001.scan | 4/4 | 100% | 11 | 1 | 1658 | - |
| letter-001.harsh | 1/4 | 13% | 2 | 1 | 1359 | sender, recipient, sent_date |
| id_document-001.scan | 4/4 | 100% | 10 | 1 | 1756 | - |
| id_document-001.harsh | 0/4 | 8% | 3 | 1 | 1259 | holder_name, id_number, issuer, expiry_date |
| policy-001.scan | 3/3 | 100% | 10 | 1 | 1243 | - |
| policy-001.harsh | 0/3 | 11% | 2 | 1 | 1265 | insurer, policy_number, expiry_date |
| bill-002.scan | 4/4 | 100% | 14 | 1 | 1247 | - |
| bill-002.harsh | 2/4 | 15% | 4 | 0.5 | 1226 | due_date, late_fee |
| receipt-002.scan | 3/3 | 97% | 13 | 1 | 1613 | - |
| receipt-002.harsh | 0/3 | 10% | 3 | 1 | 1231 | merchant, total, purchased_at |
| letter-002.scan | 4/4 | 100% | 11 | 1 | 1829 | - |
| letter-002.harsh | 1/4 | 16% | 4 | 0.3 | 1082 | sender, recipient, sent_date |
| id_document-002.scan | 4/4 | 100% | 10 | 1 | 1545 | - |
| id_document-002.harsh | 0/4 | 8% | 2 | 1 | 1252 | holder_name, id_number, issuer, expiry_date |
| policy-002.scan | 3/3 | 100% | 10 | 1 | 1106 | - |
| policy-002.harsh | 0/3 | 6% | 2 | 1 | 1160 | insurer, policy_number, expiry_date |

## Per page (no language correction)

| Page | Fields | Words | Lines | Min confidence | ms | Missed |
| --- | --- | --- | --- | --- | --- | --- |
| bill-001 | 4/4 | 100% | 14 | 1 | 1496 | - |
| receipt-001 | 3/3 | 97% | 13 | 1 | 1370 | - |
| letter-001 | 4/4 | 100% | 11 | 1 | 1589 | - |
| id_document-001 | 4/4 | 100% | 10 | 1 | 1605 | - |
| policy-001 | 3/3 | 100% | 10 | 1 | 949 | - |
| bill-002 | 4/4 | 100% | 14 | 1 | 1636 | - |
| receipt-002 | 3/3 | 97% | 13 | 1 | 1896 | - |
| letter-002 | 4/4 | 100% | 11 | 1 | 1927 | - |
| id_document-002 | 4/4 | 100% | 10 | 1 | 1850 | - |
| policy-002 | 3/3 | 100% | 10 | 1 | 999 | - |
| bill-001.scan | 4/4 | 100% | 14 | 1 | 1629 | - |
| bill-001.harsh | 2/4 | 13% | 4 | 0.3 | 1137 | due_date, late_fee |
| receipt-001.scan | 3/3 | 97% | 13 | 1 | 1580 | - |
| receipt-001.harsh | 2/3 | 10% | 4 | 0.3 | 1192 | purchased_at |
| letter-001.scan | 4/4 | 100% | 11 | 1 | 1668 | - |
| letter-001.harsh | 1/4 | 13% | 3 | 0.3 | 1203 | sender, recipient, sent_date |
| id_document-001.scan | 4/4 | 100% | 10 | 1 | 3121 | - |
| id_document-001.harsh | 0/4 | 4% | 3 | 1 | 1659 | holder_name, id_number, issuer, expiry_date |
| policy-001.scan | 3/3 | 100% | 10 | 1 | 1024 | - |
| policy-001.harsh | 0/3 | 11% | 3 | 0.3 | 1228 | insurer, policy_number, expiry_date |
| bill-002.scan | 4/4 | 100% | 14 | 1 | 1056 | - |
| bill-002.harsh | 2/4 | 15% | 3 | 1 | 1136 | due_date, late_fee |
| receipt-002.scan | 3/3 | 97% | 13 | 1 | 1519 | - |
| receipt-002.harsh | 0/3 | 10% | 3 | 1 | 1062 | merchant, total, purchased_at |
| letter-002.scan | 4/4 | 100% | 11 | 1 | 1807 | - |
| letter-002.harsh | 2/4 | 18% | 8 | 0.3 | 1471 | recipient, sent_date |
| id_document-002.scan | 4/4 | 100% | 10 | 1 | 1575 | - |
| id_document-002.harsh | 0/4 | 8% | 2 | 1 | 1153 | holder_name, id_number, issuer, expiry_date |
| policy-002.scan | 3/3 | 100% | 10 | 1 | 1006 | - |
| policy-002.harsh | 0/3 | 6% | 2 | 1 | 1249 | insurer, policy_number, expiry_date |

## How to read this

- **Field recall is an upper bound** for anything that reads this text: a
  field the OCR did not read correctly cannot be extracted from it. It is
  not an extraction score; nothing here assigns values to fields.
- **Word recall** ignores order and does not count extra words, so it
  measures what was read, not layout.
- **Timing is the sidecar's own** (image decode excluded), on the machine
  that recorded it, a CI Mac, not the dev machine
  (`docs/evals/ocr-spike.md`).

## Caveats

- Ten synthetic layouts. The degraded copies are simulated (geometric and
  photometric noise), not real scans; handwriting, folds, stamps and
  multi-page PDFs are not covered.
- `coverage_summary` is free text and not scored.
