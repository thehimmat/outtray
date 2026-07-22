# Eval methodology

Decision record: ADR-0006. This document carries the operational detail.
Status: design written Phase 0; implementation lands with Phase 1.

## Fixtures

- **Synthetic-first.** A committed generator (per-document-type HTML
  templates, locale-paired fake identities, LLM-written prose bodies,
  rendered to PDF, with a scan-degradation arm) produces fixtures AND their
  ground-truth labels in one step. Real personal documents are template
  donors only and are never committed (see
  `packages/evals/fixtures/README.md`).
- **Two fixture kinds:**
  - *Document fixtures*: one file plus expected type and per-field expected
    values. Score extraction.
  - *Pile fixtures*: a directory of N related documents plus a labeled
    expected-action list (action type, source document, deadline, severity).
    Score the action layer (the product's differentiator) at the pile level,
    including citation correctness: each proposed action must link the right
    document and page.
- **Provenance manifest.** Every committed fixture appears in a manifest with
  provenance and SHA-256 checksum; CI fails on unmanifested fixture files.
  Synthetic entries must be reproducible from the committed generator and
  seed. This replaces PII-pattern scanning, which cannot work here: good
  fixtures are supposed to look exactly like PII. One precise blocking check
  remains: a salted-hash denylist of the owner's real identifiers, stored as
  a CI secret, matched against fixture n-grams. A secrets scanner
  (gitleaks-class) runs for real credentials.
- **Bilingual coverage**: the beachhead is international relocation, so the
  set includes bilingual documents from Phase 1.

## Scoring

- **Per-field precision/recall, reported as raw counts** (e.g. 11/12) with
  Wilson intervals, per document type. No bare percentages at small N.
- **Normalization is part of the extraction contract**: dates to ISO 8601,
  decimal-separator normalization, Unicode NFC plus case folding, whitespace
  collapse. Scorers are pure TypeScript in `packages/evals` with their own
  adversarial unit tests, and eval output logs raw and normalized values so
  any drop triages to scorer-vs-model in minutes.
- **Calibration**: predictions bucketed by confidence with accuracy per
  bucket (reliability table), plus the operating-point curve: at review
  threshold t, what fraction of fields auto-pass and what is the error rate
  among them. The shipped threshold is chosen from this curve and recorded in
  an ADR. The cross-check arm's contribution (ADR-0002) is A/B measured:
  confidence with vs without it, same fixtures.

## Record/replay CI

- `pnpm eval:record` captures model inputs and outputs on the dev machine;
  `pnpm eval:live` runs against real Ollama; CI replays recordings only.
- Recordings are keyed by a SHA-256 of the full model-input contract:
  (prompt template version, rendered input, model id + digest, decoding
  params, schema version). CI recomputes and fails on mismatch: "stale
  recording, run pnpm eval:record". Replay therefore proves the committed
  recordings correspond to the current prompts and schemas, and that
  orchestration, parsing, validation, and scoring handle them correctly.
- **Noise floor**: eval:live is run 5x on one commit at temperature 0 and the
  variance published before any threshold talk. Gates compare paired
  per-fixture pass/fail against the baseline, failing on any newly-failing
  fixture unless acknowledged in a committed file with a reason.

## Scoreboard

- Committed file, append-only history. Every row is stamped with: source git
  SHA, model id + digest, prompt hash, fixture-set version (hash of the
  manifest). CI verifies stamps against HEAD, and any PR touching prompts,
  models, or schemas must also update the scoreboard.
- Comparisons are like-for-like tuples only. A PR changing the fixture set
  establishes the new baseline in the same PR, running the current code on
  old and new sets once so the discontinuity is documented.
- A standing column tracks the local-model vs cloud-frontier delta per
  document type (ADR-0003).

## Split discipline

- No held-out split below ~100 fixtures per document-type family; until
  then prompts may be tuned on the full set, disclosed as a limitation.
- Once split: held-out results print as aggregates only (no per-fixture
  diffs or transcripts); new fixtures enter held-out first, are scored blind
  at least once, then rotate to dev. A never-committed real-document set
  measures the synthetic-to-real gap, and only its aggregate reaches the
  scoreboard. A frontier model acts as second annotator, with human-model
  agreement per field reported as an inter-annotator proxy.
