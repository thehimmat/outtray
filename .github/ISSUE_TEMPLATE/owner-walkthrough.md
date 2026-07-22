---
name: Owner walkthrough
about: Pre-release learning gate. The owner runs /walkthrough against the pinned snapshot; closing this issue is the sign-off that unblocks the release.
title: "Owner walkthrough: <phase or milestone>"
labels: owner-walkthrough, owner-action
---

Run `/walkthrough` in a Claude Code session started from this repo. Closing
this issue is the owner's informed sign-off and unblocks `git tag` /
`gh release create` (enforced by a PreToolUse hook).

- **Snapshot SHA**: `<sha>` (the state this walkthrough covers; main may have
  moved on, the release is cut from here)
- **Release blocked**: `<tag, e.g. v0.1.0>`
- **ADRs to cover**: <e.g. 0002 amendment, 0009>
- **Evidence docs**: <e.g. docs/evals/model-memory-spike.md, the scoreboard>
- **Blog draft**: <docs/blog/NN-slug.md>
- **Anything else the owner should be able to defend**: <optional>
