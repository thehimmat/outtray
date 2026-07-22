# Outtray: working context

Local-first agentic document assistant. Point it at a folder of unsorted
documents; it produces a reviewed action list (to-dos, expiry alerts,
keep/shred/trash advice, attention flags) with citations. Dual purpose: the
product itself, and an interview-grade showcase of orchestration + eval rigor.
When those conflict, favor the showcase.

## Current state

- **Phase 0 complete** (scaffold, CI, ADRs 0001-0008, threat model, eval
  methodology). **Phase 1 is next**: extraction core + eval harness +
  record/replay CI + scoreboard, demoed via `outtray scan <dir>`.
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
scoreboard), `cli` (thin entry, demo surface), `app` (placeholder until
Phase 3). Decisions live in `docs/adr/`; eval design in
`docs/evals/METHODOLOGY.md`; threats in `docs/THREAT_MODEL.md`.

## Working conventions

- TDD where outputs are verifiable: failing test first. Model-dependent
  tests use recorded fixtures only; CI never runs a model.
- Every public function in core documents its failure modes in its docstring.
- ADR for every consequential decision (next number: 0009). CHANGELOG (Keep a
  Changelog) updated with user-visible changes.
- Per-phase definition of done: hard gates are automated (tests, CI,
  scoreboard no-regression); soft gates are a committed blog draft and
  CLAUDE.md updated to the new current state.
- Style: no em dashes, no emojis anywhere (docs, UI, commit messages). UI
  icons come from an icon library, never emoji. Never mention Claude in
  commit messages.
- The 8 GB machine is easily swamped: prefer `pnpm test` over watch modes,
  never leave dev servers running, avoid parallel heavy processes.

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
