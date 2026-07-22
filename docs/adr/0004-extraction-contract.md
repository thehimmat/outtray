# ADR-0004: Extraction contract

Status: accepted. Date: 2026-07-21.

## Context

Eval scoring is only meaningful at the field level, which requires knowing
which fields a document type should have. A single generic schema would make
per-field precision/recall impossible.

## Decision

- **Per-document-type Zod schemas** (Zod 4, pinned `zod@^4`) with a shared
  discriminated-union base: `DocumentBase` plus a `type` discriminant.
- Initial types: `letter`, `bill`, `receipt`, `id_document`, `contract`,
  `policy`, `statement`, `unknown`.
- **`unknown` is a first-class type, not a failure.** It routes to human
  review.
- The Zod schema is the single source of truth per type: compiled via
  `z.toJSONSchema()` into the runtime's constrained-decoding `format`
  parameter at inference time, and used again to validate the model's output
  at parse time. Constrained decoding guarantees shape, not semantic validity
  (date ranges, checksums), so the parse-time validation stays.
- Every extracted field carries a confidence score fed by cross-arm agreement
  (ADR-0002).

## Consequences

- Early Phase 1 task: verify `z.toJSONSchema()` output is accepted verbatim
  by Ollama for discriminated unions; if unions trip the grammar compiler,
  classify first with an enum-only schema, then extract with the
  type-specific schema.
- Adding a document type is a schema plus fixtures plus scoreboard rows, not
  a redesign.
