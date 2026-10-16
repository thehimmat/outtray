# Outtray: working context

Local-first agentic document assistant. Point it at a folder of unsorted
documents; it produces a reviewed action list (to-dos, expiry alerts,
keep/shred/trash advice, attention flags) with citations. Dual purpose: the
product itself, and an interview-grade showcase of orchestration + eval rigor.
When those conflict, favor the showcase.

## Current state

- **Storage foundation shipped (ADR-0011, accepted 2026-07-31; issue #78);
  `scan` is its first consumer (#79 slice 2)**: `StorageProvider` seam in core with `MemoryStorage` and
  `SqlcipherStorage`, one encrypted file at `~/Library/Application
  Support/outtray/outtray.db` (dir chmod 700), tables `documents`, `chunks`,
  `labels`, `identifiers`, `identifier_mentions`, `reviews`, migrated by `PRAGMA
  user_version`. Cipher is `cipher = 'sqlcipher'` then `legacy = 4` in that
  order, asserted at open from both the driver's pragmas and the bytes on
  disk (`storage-format.ts`); without `legacy = 4` the file is unreadable by
  any other SQLCipher implementation and leaks the header struct, see
  `docs/evals/sqlcipher-spike.md`. Key is 32 random bytes in the macOS
  Keychain, raw so no KDF runs at unlock; missing key plus existing database
  refuses to open rather than stranding it, and nothing ever falls back to an
  unencrypted store. **The native module is the workspace's first, and lives
  only in `storage-sqlcipher.ts`.** `outtray scan` persists documents via
  `persistScan` (redacted extraction always; vault only when
  `config.json` has `identifierStorage: true`; off purges on every persist).
  `scan`, `actions` and `find` are incremental (ADR-0012, #43): a file
  whose bytes, extractor key and index key match its stored row is reused
  with no model call; chunks are built on the scan write path from the
  tokenized full extraction (the store only holds redacted ones) and `find`
  ranks stored chunks, falling back to an in-memory index without a store.
  The classifier is the seeds plus the user's corrections from the store
  (`outtray correct`, #67, ADR-0009 amendment 2): a pinned type is sticky
  (`user` reconciliation status) and forces one typed re-extraction when the
  stored extraction is of another type; labels are embedded lazily from
  `derivedText` (tokenized) and re-embedded on a model change. The ADR-0011 amendment (accepted 2026-09-30, #94) fixes the
  write path: derived text gets a mode-independent `[field]` placeholder,
  `extraction_json` stores the redacted form in both modes, and `scan`
  persists documents in #79. #79 (identifier vault and tokenizer) is done
  in three slices (matcher and redaction in every output; vault, opt-in and
  scan persistence; `outtray reveal`, `outtray settings` and the disclosure
  text in `disclosure.ts`). It had to land before #43 because the tokenizer
  sits on the chunk write path and re-tokenizing later invalidates stored
  embeddings. #43 (index persistence) and #67 (label store) are done. Extracted identifiers get one canonical encrypted row, are
  tokenized out of derived chunk text, are redacted to last-four in every
  default output, need an explicit per-item act to reveal, and are **off by
  default**. Threat-model assessment in `docs/THREAT_MODEL.md`.
- **Phase 3 under way: ADR-0013 accepted (2026-10-13, #117)**: core runs in
  the Tauri webview; the app supplies Rust-backed adapters (storage over
  rusqlite, proven against the shipped store in #114; native Keychain;
  Tauri file APIs) held to the shared `StorageProvider` contract suite.
  `@outtray/core` is host-neutral; Node-only adapters live behind
  `@outtray/core/node`. Builds stay unsigned until #12. `packages/app`
  (React, Vite) renders the approval queue against an `OuttrayApi`
  interface. The Tauri shell (`packages/app/src-tauri`) hosts it for real:
  `tauri-api.ts` runs core's `scanWithStore` (the CLI's pipeline) against
  Rust commands for the store, the Keychain key (created natively, never
  sent to the page) and read-only access scoped to folders picked in the
  native picker (#123); CI builds the shell on
  ubuntu and macOS. Run end to end on the Air (#127, closed 2026-10-15): all
  six checks done; qwen3-vl:2b peaks about 1.85 GB, the app about 236 MB.
  CI tests core only under Node, so WebKit-only bugs slip through (#135
  fixed unbound `fetch` and `for await` over streams; #132 tracks a `Buffer`
  export, fixed in #141). The CLI shows a Keychain password dialog per command when the app
  created the key: accepted and documented, lasting fix waits on #12 (#134).
  "Reviewed" marks persist (ADR-0010 amendment 1, migration 4 `reviews`,
  keyed by rule, document bytes and date). The app now covers every CLI
  command: settle a questioned type (#145, `correctDocument`), search the
  planned folder (#146), and the identifier setting and reveal (ADR-0013
  amendment 1: the page cannot read the vault; `store_command` refuses
  `getIdentifier`, reveal is a Rust command showing a native dialog). The Rust
  store (`packages/app/store`: a `handle(op, args)` command layer plus a
  stdio binary for tests) passes the shared contract suite through
  `CommandStorage`; schema is one file, `core/src/migrations.json`, embedded
  by Rust. CI builds it (rust-cache) and sets OUTTRAY_REQUIRE_RUST_STORE.
- **Action layer v1 shipped (ADR-0010, accepted)**: `outtray actions <dir>`
  plans a deterministic, cited, proposed-only queue (to-dos, expiry alerts,
  keep/shred advice with rule ids + disclaimer, attention flags, review
  gating) with no model call in planning. Action-level eval (#64):
  `pnpm eval:actions` replays recorded extractions, plans as of 2026-07-22
  and matches against authored expectations
  (`docs/evals/action-scoreboard.md`, CI-gated); baseline P 10/24, R 10/13; after date normalization P 11/25, R 11/13;
  after the #65 merge of one fact flagged twice, P 11/22, R 11/13; after
  dropping field headings (#133), P 11/17, R 11/13; after dropping payment
  actions on receipts (#140), P 11/15, R 11/13.
- **Phase 4 started: cost dashboard** (`pnpm eval:cost`,
  `docs/evals/cost-dashboard.md`, CI-gated against `fixtures/cost.json`):
  breaks each recorded extraction into load, prefill and generating
  (prefill by difference until the next re-record; recordings now keep
  `promptMs`, #153). `pnpm eval:noise [runs]` measures the noise floor
  live on the Air (#154). Median 31.8 s per document on the Air, prefill 89%, at
  about 118 prompt tokens/s against the memory spike's 1,830 for the same
  model: likely a GPU spill at the larger context, measured on the Air in
  #152 before any performance work. Phase 3 closes after #149 (on-device
  check of the app features and the demo video); then post the Phase 3
  checkpoint and file the walkthrough issue pinned to that SHA.
- **OCR arm built (#8, ADR-0002 amendment 2)**: `packages/ocr-vision`
  (SwiftPM, `outtray-ocr <image>`, `VNRecognizeTextRequest`) prints an
  `ocr-v1` result validated by `core/src/ocr-contract.ts`; `VisionOcr` in
  `@outtray/core/node` runs it. Recordings in `evals/recordings/ocr`,
  `pnpm eval:ocr` (`docs/evals/ocr-scoreboard.md`): 36/36 labelled values
  present, 373/375 words, about 2 s and 207 MB per page on the CI Mac. The
  `ocr` CI job (macos-latest) builds it and fails if a field it read is
  missed. Swift cannot be built in the cloud container: push, and on a
  same-repo PR the `ocr` job records every page in both variants and
  commits changed recordings to the branch (a workflow-token push starts
  no CI, so push again after pulling it). Degraded pages (#160,
  `fixtures/degraded`, `scripts/degrade-fixtures.py`): scan 36/36, harsh
  8/36 (body text undetected), confidence 1.0 on misreads, language
  correction immaterial; `--enhance` preprocessing takes harsh from 8 to
  11/36 (4 gained, 1 lost, no identifier), so it is off by default. The bot's push
  sends no event to this session: after a recording run, fetch the branch
  instead of waiting. Not wired into `scan` yet; classify-first
  (ADR-0009 section 1) and #97 build on it.
- **Competitive teardown** (`docs/research/competitive-teardown.md`, #155,
  #156, from vendor sites and repos): paperless-ngx v3 has opt-in local AI;
  paperless-ai is unmaintained; Paperspell (cloud) shows per-document
  suggested actions and a library-wide expiry calendar; Duely is an
  email-forward renewal tracker. Still unclaimed: local, retention advice
  with cited rules, one reviewed queue across a whole pile. Hands-on checks
  remain on #9. ppspell.com, getduely.app and the app stores are on the
  cloud environment's network allowlist.
- **Waiting on the Air**: #149, #152, #130 (zod bump needs `pnpm
  eval:record`), #9 hands-on. Cloud-doable leftovers are low value until
  those land (#106, #147) or depend on them (#20).
- **ADR-0009 stage complete end to end** (amendment accepted, #54): two-stage
  scan with reconciliation verdicts plus one typed re-extraction on confident
  disagreement (`extract-typed-v1`). Scoreboard: VLM 8/10, classifier 10/10,
  reconciled 10/10 (`docs/evals/classification-scoreboard.md`; dev-run, #52
  tracks CI replay). The personalization scope of #30 landed with #67;
  measuring accuracy with N corrections is #108 (needs the dev machine).
- **Phase 2 complete**: retrieval plumbing (`EmbeddingProvider` +
  `OllamaEmbeddingProvider`, chunking, `VectorIndex` brute-force cosine per
  ADR-0005, cited `retrieve`/`search`), demoed via `outtray find <dir>
  "<query>"`. Q&A deferred; the embedding-model ADR deferred; index
  persistence landed with ADR-0012. The Tauri shell is Phase 3 (ADR-0001), not before.
- **Phase 1 complete**: extraction core (`ModelProvider` + `OllamaProvider`
  around `qwen3-vl:2b`, ADR-0004 discriminated-union contract, `extract()` +
  `outtray scan`), eval harness (record/replay, scorers, 10-fixture synthetic
  set), and a CI replay gate over a real scoreboard (qwen3-vl:2b: overall P 95%
  / R 77%; `docs/evals/scoreboard.md`). ADR-0002 amended (2b default) and
  accepted. Phase 1 and Phase 2 each await an owner walkthrough before any
  release tag.
- **Phase 0 complete** (scaffold, CI, ADRs 0001-0008, threat model, eval
  methodology).
- Day-14 checkpoint target: public repo, README + diagram, ADRs, CLI scan
  over 10+ fixtures with Zod-validated confidence-scored output, scoreboard
  with real numbers, record/replay CI gate, first blog post draft (the CI
  evals post is the flagship).

## Hard constraints

- **Memory**: dev machine and target are a 2022 MacBook Air, 8 GB unified
  memory. Inference budget ~4 GB peak, ONE resident model at a time, models
  in the 4B-and-under class (ADR-0002). Never propose 7B+ local models.
- **`packages/core` never imports Tauri.** Domain logic runs under plain
  Node. The Tauri shell is written in Phase 3, not before (ADR-0001).
- **Cloud providers only ever see fixture documents, never user documents**,
  until the Phase 5 opt-in UI exists (ADR-0003).
- **Real personal documents are never committed** (fixture policy:
  `packages/evals/fixtures/README.md`).
- **No destructive tools in v1**: the agent proposes, the human acts
  (ADR-0008).

## Stack and commands

pnpm workspaces; TypeScript strict + project references; Vitest; Biome;
Conventional Commits; squash-merge PRs to an always-releasable main.

- `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm build`
- `pnpm eval:live`, `pnpm eval:record` (land in Phase 1)

Packages: `core` (pure domain logic), `evals` (harness/fixtures/scorers/
scoreboard), `cli` (thin entry, demo surface), `app` (React UI over the host-neutral
core, in the Tauri shell `app/src-tauri`). Decisions live in `docs/adr/`; eval design in
`docs/evals/METHODOLOGY.md`; threats in `docs/THREAT_MODEL.md`.

## Ownership, autonomy, and owner checkpoints

Claude owns this project end to end (owner decision, 2026-10-13): it plans,
builds, reviews and merges its own work, and stops only for a critical
decision. The owner steers through those decisions and through the
walkthrough gate before each release. The showcase still depends on the owner
being able to defend every piece in an interview, so everything Claude
decides alone is written down where the walkthrough will find it (ADRs, PR
"Decisions" sections, the checkpoint report).

### Claude merges its own PRs

Squash-merge a PR without waiting for the owner when all of these hold:

- CI is green on the PR's current head.
- The repo's own checks passed locally before the push (`pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm build`).
- A self-review pass over the diff found nothing blocking (run
  `/code-review` or an equivalent adversarial read; fix what it finds).
- The PR description has what works now, numbers, and a "Decisions" section
  (choices made, options turned down, open items).
- It does not contain a critical decision (below). If it does, open the PR,
  file the decision as an issue, and leave the PR for the owner.

Dependabot PRs: merge when CI is green, unless the bump changes the
extraction contract hash or anything else that needs a live model to
re-record (see #88); those wait for a dev-machine session.

### Critical decisions: the only reasons to stop

1. **Money.** Anything that costs money is always the owner's decision.
2. **Public-facing acts beyond pushing to this repo**: publishing a blog
   post, publishing to npm, registering a domain, tagging a release or
   cutting a GitHub release, posting anywhere. Claude drafts; the owner
   publishes. Tags also stay blocked by the walkthrough hook.
3. **Weakening a hard constraint or the privacy posture**: the memory budget,
   cloud providers seeing user documents, committing real documents,
   destructive tools, identifier storage defaults, anything in
   `docs/THREAT_MODEL.md` getting worse.
4. **Reversing an accepted ADR's core decision** (a different storage engine,
   model class, shell, or extraction contract shape). Amendments that refine
   how an accepted decision is built are Claude's to make: write the
   amendment with its "Options considered" section in plain language, mark it
   accepted by Claude with the date, and merge it.
5. **Irreversible or destructive repository actions**: force-pushing `main`,
   deleting history or branches with unmerged work, closing an issue the
   owner opened with a question they have not answered.
6. **Product direction and naming**: positioning, scope that drops a planned
   phase, trademark and name claims.

Everything else is Claude's call, including new ADRs, phase transitions, and
which issue to work next. When a non-critical question has a reasonable
default, take it, record it in the PR's Decisions section (and the issue, if
one exists), and keep going; the owner can reverse it later.

### Phase boundaries

A phase boundary is not a stop. At each one, finish the phase's definition of
done, post the checkpoint report (below) on the phase's tracking issue, file
the owner-walkthrough issue pinned to the phase-end SHA, commit the blog
draft, then start the next phase. #75's format risk is retired (Rust reads and
writes the shipped store, #114); signing and notarization wait on #12, which
the owner deferred until a real external tester exists, so Phase 3 builds
are unsigned until then.

### The checkpoint report (what to prepare at every phase boundary and stop)

A short write-up, in the PR description or a comment on the phase's tracking
issue, containing:

- **What works now**, with the exact command to see it (e.g. `pnpm cli scan
  fixtures/demo`). The owner must be able to run the demo in under a minute.
- **Numbers**: scoreboard metrics or measurements, with deltas from the
  previous checkpoint and honest caveats (N, noise, what is not measured).
- **Drafts prepared, not published**: blog drafts committed to `docs/blog/`,
  release notes drafted, ADR amendments proposed.
- **Decisions made**: what Claude decided alone since the last checkpoint,
  each with a link, so the walkthrough can cover them.
- **Decisions needed**: only critical ones, each as a GitHub issue with a
  recommendation, labeled `owner-action` and a priority.
- **What comes next** if approved, in two or three sentences.

### Release and publication cadence

- **Tags/releases**: from Phase 1 onward each completed phase gets a tag and
  a GitHub release, cut only after the owner has seen the checkpoint report
  AND closed the phase's owner-walkthrough issue. When preparing a checkpoint
  report, also file an issue from the "Owner walkthrough" template
  (`.github/ISSUE_TEMPLATE/owner-walkthrough.md`) pinned to the phase-end
  SHA, listing the phase's ADRs, evidence docs, and blog draft. The owner
  runs the `/walkthrough` skill against that snapshot (tutor + quiz + mock
  interview; see `.claude/skills/walkthrough/SKILL.md`); closing the issue is
  their informed sign-off. A PreToolUse hook blocks `git tag` and
  `gh release create` while any owner-walkthrough issue is open. Release
  notes come from the CHANGELOG and link the phase's blog post once it is
  published.
- **Blog pipeline**: drafts live in `docs/blog/` (one file per post, named
  `NN-slug.md`). A phase is incomplete without its draft committed.
  Publication is always the owner's manual act, targeted within a week of
  phase end. Priority order: (1) the record/replay CI flagship post at the
  end of Phase 1, (2) "what local inference actually costs on an 8 GB Air" /
  two-stage vs VLM measured (seeded by docs/evals/model-memory-spike.md),
  (3) the rest per the plan's schedule.
- **Issue hygiene**: anything left unfinished, any discovered bug or idea,
  and any critical question for the owner becomes a GitHub issue with a
  priority label before the session ends. `owner-action` is reserved for
  critical decisions; a non-critical question is decided by default and the
  decision recorded on its issue.

## Working conventions

- TDD where outputs are verifiable: failing test first. Model-dependent
  tests use recorded fixtures only; CI never runs a model through Ollama or
  a cloud provider. The one exception is the `ocr` job, which runs the
  OS's own Vision OCR live on macOS as a build check and a no-regression
  gate (ADR-0002 amendment 2); the numbers still come from recordings.
- Every public function in core documents its failure modes in its docstring.
- ADR for every consequential decision (next number: 0014). CHANGELOG (Keep a
  Changelog) updated with user-visible changes.
- Style: no em dashes, no emojis anywhere (docs, UI, commit messages). UI
  icons come from an icon library, never emoji. Never mention Claude in
  commit messages.
- The 8 GB machine is easily swamped: prefer `pnpm test` over watch modes,
  never leave dev servers running, avoid parallel heavy processes. Ollama
  inference uses most of RAM; do not run it concurrently with builds.
- Multi-session work uses git worktrees rather than sharing one checkout.

## Phase sequencing notes

- Phase 2 is timeboxed retrieval plumbing (embeddings + cosine ranking +
  citations for the planner); user-facing Q&A chat is deferred, a CLI
  subcommand at most. RAG is commoditized; the action layer is the
  differentiator, so it gets the time.
- Positioning: the demo and launch story lead with the action queue
  (keep/shred/trash + attention flags), never folder organizing. The
  pre-written competitive answer is "paperless-ngx organizes and finds;
  Outtray tells you what needs doing, locally." Honest comparisons against
  paperless-ngx/paperless-ai, Paperspell, and Duely are planned positioning
  work (see open issues).
