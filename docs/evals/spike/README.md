# Memory-spike artifacts (issue #5)

Throwaway measurement tooling and evidence for
[`../model-memory-spike.md`](../model-memory-spike.md). **Not pipeline code**
and not the Phase 1 eval harness. Kept only so the numbers are reproducible.

- `renewal-notice.html` — synthetic source document (invented identity and
  figures, no real PII). Renders deterministically to the page used in the run.
  SHA-256 `fc68c1b6e72965b0c319bc443f9206f95b7a501f880c50b191017e3e098324dd`.
- `spike.mjs` — the harness. Standalone Node ESM; needs `zod@^4` installed in a
  throwaway dir (`npm i zod@^4`). Depends on a local Ollama at
  `127.0.0.1:11434`.
- `union.schema.json` — the `z.toJSONSchema()` output of the discriminated
  union passed to Ollama as `format`.
- `result-*.json` — raw harness output per candidate model.

When the Phase 1 fixture generator and manifest land, the real fixture set
supersedes `renewal-notice.html`; this directory can be deleted at that point.
