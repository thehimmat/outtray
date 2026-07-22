# ADR-0006: Eval-first development

Status: accepted. Date: 2026-07-21.

## Context

Extraction has verifiable outputs, so TDD genuinely applies; the labeled
fixture set is the test suite. The eval harness is also the highest-signal
showcase artifact of the project, which means it must survive scrutiny from a
skeptical interviewer, not just pass CI.

## Decision

- **Eval-first**: the fixture set and scorers are built alongside the first
  pipeline code in Phase 1, not retrofitted in Phase 4. The record/replay CI
  gate and the committed scoreboard are Phase 1 exit criteria.
- **Record/replay CI**: model inputs and outputs are recorded to fixtures;
  CI replays them deterministically. Every recording is keyed by a content
  hash of the full model-input contract (prompt template version, rendered
  input, model id and digest, decoding params, schema version); CI recomputes
  the hash and fails on mismatch with "stale recording, run `pnpm
  eval:record`".
- **Scoreboard with provenance**: the committed scoreboard embeds source git
  SHA, model digest, prompt hash, and fixture-set hash; CI verifies the
  embedded hashes against HEAD so the scoreboard cannot silently go stale.
- **Regression gate by paired per-fixture flips**, not aggregate thresholds:
  any newly-failing fixture fails CI unless acknowledged in a committed file
  with a reason. Aggregate metrics are reported as raw counts with confidence
  intervals.
- **No held-out split until fixtures exceed ~100 per document-type family.**
  Until then, prompts may be tuned against the full set and the writeups
  disclose this honestly as a limitation.
- **Synthetic-first fixtures**: the generator (templates plus locale-paired
  fake data, rendered to PDF with a scan-degradation arm) is the primary
  fixture source because it emits ground-truth labels for free. A small
  never-committed real set measures the synthetic-to-real gap, reported as a
  number on the scoreboard.
- Full design detail lives in `docs/evals/METHODOLOGY.md`.

## Consequences

- Model or prompt changes force re-recording, which is the point: the gate
  proves the committed recordings correspond to the current system.
- The scoreboard becomes the single strongest interview artifact: "here is my
  scoreboard and the CI gate that fails on regressions."
