# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(0.x until Phase 5).

## [Unreleased]

### Added

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
