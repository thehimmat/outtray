# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(0.x until Phase 5).

## [Unreleased]

### Added

- "Reviewed" marks in the desktop app are saved in the encrypted store and
  come back on the next scan (ADR-0010 amendment 1). A mark follows the
  document's contents, so a moved file keeps it and a re-issued bill starts
  unreviewed; deleting a document drops its marks. A mark changes no file.

- The desktop app runs for real (Phase 3, `packages/app/src-tauri`): a Tauri
  shell that scans the chosen folder with the same incremental pipeline as
  `outtray scan` and saves to the same encrypted store. The database key
  stays in the Rust side and never reaches the page; on first run the app
  creates it in the Keychain with a native call, so it never appears in a
  process argument list. The shell's file commands only list and read:
  no command writes, moves or deletes a document. macOS only,
  unsigned until a signing identity exists.

- The desktop app's encrypted store, in Rust (`packages/app/store`,
  ADR-0013), reached from core through `CommandStorage`. It passes the same
  37-test `StorageProvider` contract suite as the CLI's store, and the two
  read and write the same file. CI builds it and fails if it is missing.

- The desktop app's first screen (Phase 3, `packages/app`): choose a folder,
  see its proposed action queue grouped as in the CLI, each item with its
  citations, review-gated items marked and a "Reviewed" note the person can
  tick. Runs today against a demo host that plans synthetic documents with
  the real core planner in the page; the Tauri adapters come next.

### Changed

- The store's migration list now lives in one file,
  `packages/core/src/migrations.json`, used by both the CLI's store and the
  desktop app's Rust store, so their schemas cannot drift.

- `@outtray/core` is now host-neutral so it can run inside the desktop app's
  webview (ADR-0013, accepted). Node-only pieces (the encrypted SQLite store,
  the Keychain key, the settings file, app paths, and folder scanning) moved
  to `@outtray/core/node`. Scans read through a `DocumentSource`, and content
  hashing uses Web Crypto. No change in CLI behaviour.

### Fixed

- A damaged encrypted store now says so in plain terms (it is only a cache,
  your documents are untouched, delete it and re-scan) instead of a SQLite
  error, and a file cut off mid-page is no longer misreported as a wrong
  key. A store locked by another Outtray command says that too (#84).
- Purges are zeroed in the file, not only removed in SQL: `secure_delete`
  is pinned on and checked at open, and a test decrypts every page after a
  purge to prove the value is gone (#84).

- An ID number the model wrote into an action item's due date is now
  redacted and tokenized like everywhere else; before, it could reach the
  action queue in full. Found by the action-level eval (#64).
- The planner reads dates written out in words ("January 6, 2025") the way
  the eval already scored them, and treats a due date that is not a date as
  no date instead of comparing it as text. Action recall 10/13 to 11/13.
- One fact is no longer flagged twice (#65): an extracted to-do or past-due
  flag on the same document and date as an expiry alert or expired flag
  folds into it, keeping both citations. Action precision 11/25 to 11/22.

### Added

- Action-level eval (#64): `pnpm eval:actions` scores the proposed action
  queue against actions authored from each fixture's ground truth, from the
  recorded extractions and with no model. Baseline: precision 10/24, recall
  10/13 (`docs/evals/action-scoreboard.md`). CI replays it and fails on
  drift.

- `outtray correct <file> <type>` marks a document's type yourself (#67,
  ADR-0009 amendment 2). Your type wins over the extractor and classifier on
  every later scan; if the document was read as another type, the next scan
  reads it again as yours so the right fields are extracted. Each correction
  becomes an example the classifier learns from, stored in the encrypted
  database from tokenized text (never an ID number or its last four). Needs
  no model; the example is embedded the next time a scan classifies
  something.

- `outtray scan`, `outtray actions` and `outtray find` are incremental
  (ADR-0012, #43). A file whose contents, extraction model and prompts are
  unchanged since its last scan is read from the encrypted store with no
  model call, so repeating a command over the same folder is near-instant
  and `find` over an unchanged folder only embeds the query. Changing the
  model or a prompt version re-reads everything once. Turning identifier
  storage on re-reads documents whose number is not stored yet. Without the
  store (not macOS, Keychain locked), `find` still works from an in-memory
  index, as before.

- `outtray scan` now saves what it found to the encrypted store (ADR-0011,
  #79 slice 2), the store's first consumer. The first scan on a Mac creates
  the database and its Keychain key. Stored extractions always carry the
  redacted form of an identifier, never the full value. A store that cannot
  be opened is reported on stderr and the scan output still stands.
- Identifier vault, off by default. With `"identifierStorage": true` in
  `~/Library/Application Support/outtray/config.json`, scan also stores each
  passport, policy or account number once, in full, in its own encrypted
  table, however many documents mention it. With it off (the default, or a
  missing or unreadable file), nothing but the last four is kept, and any
  previously stored values are purged on the next scan.
- `outtray settings identifier-storage on|off` switches identifier storage
  (#79 slice 3). Turning it on shows a short disclosure and asks first (or
  needs `--yes` without a terminal); turning it off deletes every stored
  number at once. `outtray settings` shows the setting and the disclosure.
- `outtray reveal <file> <field>` prints one stored ID number in full, for one
  document and one named field, on stdout only. It finds a moved file by its
  contents, and says why when there is nothing to show (setting off, not
  re-scanned since turning it on, or the document carries another field).
- `outtray reveal` refuses to write a full number into a pipe or file unless
  `--to-pipe` is given (#101), so an accidental redirect fails closed while
  `outtray reveal <file> <field> --to-pipe | pbcopy` still works.
- The scan that creates the encrypted store says where it is and what happens
  to ID numbers.

- Storage foundation (ADR-0011): a `StorageProvider` seam in `packages/core`
  alongside `ModelProvider` and `EmbeddingProvider`, with an in-memory
  implementation and an encrypted-SQLite adapter over
  `better-sqlite3-multiple-ciphers`, the workspace's first native dependency.
  One file at `~/Library/Application Support/outtray/outtray.db` in a
  directory created owner-only, holding documents, chunks, labels and the
  identifier tables, migrated by `PRAGMA user_version`. The key is 32 random
  bytes in the macOS Keychain, passed raw so no KDF runs at unlock. Opening
  asserts the upstream-compatible SQLCipher format twice, from the pragmas the
  driver reports and from the bytes on disk, so a dependency bump cannot
  silently change the on-disk format. Nothing consumes the store yet: `scan`,
  `find` and the classifier are unchanged.
- Action layer v1 (ADR-0010): `outtray actions <dir>` scans a folder and
  proposes a deterministic action queue: to-dos from extracted action items
  (deduplicated, past-due ones flagged), expiry alerts inside a 60-day window
  (expired documents flagged), keep/shred retention advice from a small
  versioned rules table cited by rule id and carrying a non-advice
  disclaimer, and attention flags for unreadable documents and type disputes.
  Every item cites its verbatim extracted evidence, items from documents
  needing review are marked "review first", everything is proposed-only, and
  no model is called in the planning step.
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

### Changed

- Identifiers (passport and ID numbers, policy numbers, account numbers) no
  longer appear in full in any output (ADR-0011 amendment, #79 slice 1).
  `outtray scan` and `outtray actions` show them as last four plus length,
  e.g. `[id_number ending 4567, 9 chars]`, or length only for values under 8
  characters. `outtray find` indexes and cites `[id_number]` instead of the
  value. Matching ignores spacing, dashes and case and tolerates common OCR
  confusions (O/0, I/L/1, S/5, B/8, Z/2); a number the model rewrote beyond
  those variants can still slip through, so this reduces exposure rather
  than guaranteeing it.
- `better-sqlite3-multiple-ciphers` 12.11.1 to 13.0.3 (SQLite3 Multiple
  Ciphers 2.3.5 to 2.4.0, SQLite 3.53.2 to 3.53.4). The package now ships
  Node-API prebuilds for every supported platform, so `pnpm install` no longer
  compiles it from source (about 39 s saved on a cold install). The on-disk
  format assertions pass unchanged.
