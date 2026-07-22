# ADR-0003: ModelProvider abstraction and the cloud escape hatch

Status: accepted. Date: 2026-07-21.

## Context

The app ships local-only through Phase 4 to keep the privacy claim clean, but
the eval story needs a frontier-model quality ceiling to compare against, and
a future BYO-API-key option (Phase 5) should not require retrofitting an
abstraction.

## Decision

- All inference goes through a **ModelProvider interface** in
  `packages/core` from the first pipeline commit.
- **Two providers exist in Phase 1:**
  - `OllamaProvider`: the shipped default.
  - One BYO-key cloud provider: **eval-harness only**, gated behind an
    environment variable, hard-excluded from any app bundle until the Phase 5
    opt-in UI exists.
- **Hard rule: cloud providers only ever receive fixture documents, never
  user documents, until the Phase 5 opt-in ships.** This rule is enforced in
  code (the harness is the only call site wired to the cloud provider), not
  just documented.

## Consequences

- The scoreboard carries a standing "local 4B vs frontier ceiling" delta per
  document type: exactly the eval-rigor evidence the showcase needs.
- The privacy claim stays verifiable: the shipped app has no cloud code path
  before Phase 5, and the "what leaves the machine" table in the README stays
  short.
