# Spike artifacts

Throwaway measurement tooling and evidence for the spike write-ups in the
parent directory. **Not pipeline code** and not the eval harness. Kept only so
the numbers are reproducible.

## Model memory spike (issue #5)

Evidence for [`../model-memory-spike.md`](../model-memory-spike.md).

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
supersedes `renewal-notice.html`; those files can be deleted at that point.

## SQLCipher build-path spike (issue #6)

Evidence for [`../sqlcipher-spike.md`](../sqlcipher-spike.md), which feeds
ADR-0011.

- `sqlcipher-spike.mjs` - the harness. Standalone Node ESM. Needs
  `better-sqlite3-multiple-ciphers` installed in a throwaway directory, and
  resolves it from the **cwd** on purpose, so the native dependency never
  enters the workspace lockfile:

  ```bash
  mkdir /tmp/sqlcipher-spike && cd /tmp/sqlcipher-spike
  npm i better-sqlite3-multiple-ciphers
  node /path/to/outtray/docs/evals/spike/sqlcipher-spike.mjs ./out
  ```

  The interop check additionally needs an independent SQLCipher build
  (`brew install sqlcipher`); the command is in the write-up.
- `result-sqlcipher.json` - raw output of the reported run: per-cipher-mode
  pragmas, on-disk header bytes, pass/fail checks, and timings against a
  plaintext baseline.
