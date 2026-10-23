# Outtray: phase boundaries and releases

What to do at the end of a phase. Moved out of `.claude/CLAUDE.md` because it
only matters at a phase boundary.

## Phase boundaries

A phase boundary is not a stop. At each one, finish the phase's definition of
done, post the checkpoint report (below) on the phase's tracking issue, file
the owner-walkthrough issue pinned to the phase-end SHA, commit the blog
draft, then start the next phase. #75's format risk is retired (Rust reads and
writes the shipped store, #114); signing and notarization wait on #12, which
the owner deferred until a real external tester exists, so Phase 3 builds
are unsigned until then.

## The checkpoint report (what to prepare at every phase boundary and stop)

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

## Release and publication cadence

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
