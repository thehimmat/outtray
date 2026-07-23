# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(0.x until Phase 5).

## [Unreleased]

### Added

- Typed re-extraction closes the reconciliation loop (accepted ADR-0009
  amendment): when the classifier confidently disagrees with the VLM's type,
  scan re-extracts that document once under the classifier's type-specific
  schema branch and reports it as `corrected from <type>`; a re-extraction
  that fails or comes back off-type leaves the item flagged for review.
- Two-stage `outtray scan` (ADR-0009): after extraction, the on-device k-NN
  classifier votes on each document's type from its extraction text and the
  report carries a reconciliation verdict per item. Agreement is confirmed
  with its confidence; a confident disagreement is flagged "needs review"
  (auto-correction awaits the ADR-0009 amendment sign-off, issue #54); a
  low-confidence disagreement renders as `unknown` for human review; and an
  unavailable embedder degrades scan to single-stage VLM labels with a
  notice, never a failure.

- Phase 2 retrieval plumbing: an `EmbeddingProvider` seam with a local
  `OllamaEmbeddingProvider`, document chunking, and a `VectorIndex` that ranks
  chunks by in-TypeScript brute-force cosine (ADR-0005) and returns cited
  passages (document id, page, chunk index). Demoed via `outtray find <dir>
  "<query>"`; user-facing Q&A remains deferred.
- Phase 1 extraction core: a `ModelProvider` seam with a local `OllamaProvider`
  (default `qwen3-vl:2b`, `think:false` plus content-or-thinking JSON recovery),
  the ADR-0004 discriminated-union extraction contract, and `extract()` wired
  into `outtray scan <dir>` to produce an action list from a folder of pages.
- Phase 1 eval harness: record/replay provider (SHA-keyed recordings, CI
  replays and never calls a model), field scorers (normalization + per-field
  precision/recall with Wilson intervals), a deterministic 10-fixture synthetic
  set with a checksummed manifest, and a committed scoreboard with a CI
  no-regression gate. First numbers: qwen3-vl:2b overall P 95% / R 77%.
- Memory spike results (`docs/evals/model-memory-spike.md`) and the ADR-0002
  amendment accepting `qwen3-vl:2b` as the Phase 1 local default.
- pnpm monorepo scaffold: `packages/core` (pure TypeScript domain logic),
  `packages/evals` (harness, fixtures, scorers), `packages/cli` (thin CLI entry),
  `packages/app` (placeholder until Phase 3).
- CI workflow: lint, typecheck, test, build on every PR and push to main.
- ADRs 0001 through 0008 covering shell/stack, local inference, the model
  provider abstraction, the extraction contract, storage, eval-first
  development, data-at-rest posture, and action-layer guardrails.
- Threat model (`docs/THREAT_MODEL.md`) and eval methodology
  (`docs/evals/METHODOLOGY.md`).
- Fixture privacy policy enforced via `.gitignore` and documented in
  `packages/evals/fixtures/README.md`.
