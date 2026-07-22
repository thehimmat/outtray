# ADR-0008: Action-layer guardrails

Status: accepted. Date: 2026-07-21.

## Context

Documents are untrusted input. A phishing letter is attacker-authored text
fed to the very agent that judges phishing, and "a human approves" is weak on
its own because the attacker authors what the human reads. The action layer
(Phase 3) is the product's differentiator, so its trust design is decided
before it is built.

## Decision

1. **Document text enters prompts only as delimited data blocks**, never
   concatenated into instruction position.
2. **Every action-queue item displays a verbatim source snippet and a page
   image crop next to the agent's paraphrase**, so the reviewer sees raw
   evidence, not only model output. Citations are non-negotiable.
3. **The agent proposes; the app never executes destructive operations in
   v1.** Keep/shred/trash is advice rendered as text. There is no delete-file
   tool at all.
4. Extraction outputs cross the boundary into planning only as
   **Zod-validated typed data** (ADR-0004), never as free text.
5. **Anomaly flags are framed as "attention flags", never as a safety
   verdict.** The UI never renders an "all clear" state, only "N items
   flagged, M not yet reviewed by you"; absence of a flag is explicitly not a
   judgment. The flags' measured precision/recall from the scoreboard is
   published in the docs.
6. Retention advice carries a one-line non-advice disclaimer: keep/shred has
   legal implications for tax and immigration documents, which is precisely
   the beachhead user's highest-stakes paperwork.

## Consequences

- The approval gate is real: the human reviews evidence, not paraphrase.
- Honest uncertainty becomes showcase material instead of liability.
