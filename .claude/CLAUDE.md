# Outtray: working context

Local-first agentic document assistant. Point it at a folder of unsorted
documents; it produces a reviewed action list (to-dos, expiry alerts,
keep/shred/trash advice, attention flags) with citations. Dual purpose: the
product itself, and an interview-grade showcase of orchestration + eval rigor.
When those conflict, favor the showcase.

## Current state

- **Phase 1 complete** (hard gates): extraction core (`ModelProvider` +
  `OllamaProvider` around `qwen3-vl:2b`, ADR-0004 discriminated-union contract,
  `extract()` + `outtray scan`), eval harness (record/replay, scorers,
  10-fixture synthetic set), and a CI replay gate over a real scoreboard
  (qwen3-vl:2b: overall P 95% / R 77%; `docs/evals/scoreboard.md`). ADR-0002
  amended (2b default) and accepted. Awaiting the owner walkthrough before any
  release tag. **Phase 2 next**: timeboxed retrieval plumbing (see below).
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
scoreboard), `cli` (thin entry, demo surface), `app` (placeholder until
Phase 3). Decisions live in `docs/adr/`; eval design in
`docs/evals/METHODOLOGY.md`; threats in `docs/THREAT_MODEL.md`.

## Visibility, releases, and owner checkpoints

The owner steers this project through explicit checkpoints. Development may
move fast between them, but every session must know where to stop and what to
hand over. The showcase depends on the owner understanding and being able to
defend every piece in an interview, so an unreviewed feature is worth less
than a reviewed smaller one.

### Where a session stops (hard stops, no exceptions)

1. **Phase boundaries.** Finish the phase's definition of done, prepare the
   checkpoint report (below), then stop. Do not start the next phase's code.
2. **ADR changes.** If work reveals that an accepted ADR needs amending
   (model default, storage mechanism, schema shape), write the proposed
   amendment and stop for owner sign-off before building on it. Every ADR
   proposal or amendment includes an "Options considered" section in plain
   language: each realistic option with pros and cons a non-expert can
   follow. The owner's quick sign-off (merging the PR) keeps development
   moving; deep understanding is deferred to the walkthrough gate below.
3. **Anything public-facing beyond pushing code to this repo**: publishing a
   blog post, publishing to npm, registering a domain, tagging a release,
   posting anywhere. Claude drafts; the owner publishes.
4. **Anything that costs money.** Always an owner decision, always stop.

### The checkpoint report (what to prepare at every stop)

A short write-up, in the PR description or a comment on the phase's tracking
issue, containing:

- **What works now**, with the exact command to see it (e.g. `pnpm cli scan
  fixtures/demo`). The owner must be able to run the demo in under a minute.
- **Numbers**: scoreboard metrics or measurements, with deltas from the
  previous checkpoint and honest caveats (N, noise, what is not measured).
- **Drafts prepared, not published**: blog drafts committed to `docs/blog/`,
  release notes drafted, ADR amendments proposed.
- **Decisions needed**: each open decision as a GitHub issue with a
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
  and any question for the owner becomes a GitHub issue with a priority
  label before the session ends. Questions to the owner always get a
  matching issue so unanswered ones are never lost.

## Working conventions

- TDD where outputs are verifiable: failing test first. Model-dependent
  tests use recorded fixtures only; CI never runs a model.
- Every public function in core documents its failure modes in its docstring.
- ADR for every consequential decision (next number: 0009). CHANGELOG (Keep a
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
