# Outtray: working context

Local-first agentic document assistant. Point it at a folder of unsorted
documents; it produces a reviewed action list (to-dos, expiry alerts,
keep/shred/trash advice, attention flags) with citations. Dual purpose: the
product itself, and an interview-grade showcase of orchestration + eval rigor.
When those conflict, favor the showcase.

## Current state

See [`docs/STATUS.md`](../docs/STATUS.md) for where each phase stands, open
issues waiting on the Air, and the latest eval numbers. Read it before picking
the next issue, and update it (not this file) when status changes.

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
- `pnpm eval:live`, `pnpm eval:record`

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

### Phase boundaries and releases

A phase boundary is not a stop. When a phase's definition of done is met,
follow [`docs/PHASE_BOUNDARIES.md`](../docs/PHASE_BOUNDARIES.md): checkpoint
report, owner-walkthrough issue, blog draft, then the next phase. Tags and
releases wait for the owner's walkthrough (a hook enforces this).

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

## Positioning

- Positioning: the demo and launch story lead with the action queue
  (keep/shred/trash + attention flags), never folder organizing. The
  pre-written competitive answer is "paperless-ngx organizes and finds;
  Outtray tells you what needs doing, locally." Honest comparisons against
  paperless-ngx/paperless-ai, Paperspell, and Duely are planned positioning
  work (see open issues).
