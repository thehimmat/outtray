# ADR-0010: Action layer v1, deterministic planning over typed extractions

Status: **accepted 2026-07-22** on owner sign-off (issue #58). Owner comment:

> option 1 sounds like the right direction. go ahead

The accepted design is option 1 below: a deterministic rule-based planner in
core, no model call in the planning step.

## Context

The action queue is the product differentiator: "paperless-ngx organizes and
finds; Outtray tells you what needs doing, locally." ADR-0008 fixed the trust
guardrails for that layer before it was built. This ADR decides the mechanism
and the shape.

The pipeline now produces everything the layer needs: per-document
Zod-validated extractions (ADR-0004) with `action_items` and type-specific
date and amount fields, and a per-document type-reconciliation verdict with a
review flag (ADR-0009 amendment). What is missing is the step that turns a
folder of those into one reviewed list of things to do.

The tempting default is to hand all extractions to a model and ask it to
write the list. That puts attacker-authored document text one hop from the
text the human acts on, exactly the threat ADR-0008 exists for, and makes the
differentiator the one part of the pipeline CI could not test without a model.

## Decision (proposed)

- **v1 planning is a deterministic pure function in core, no model call.**
  `planActions` maps the scan report (typed extractions plus reconciliation
  verdicts) to a typed `ActionQueue`. Every input crosses the boundary as
  Zod-validated data, never free text (ADR-0008 point 4). With no prompt in
  the planning step, document text cannot reach instruction position at all,
  so ADR-0008 point 1 holds by construction rather than by prompt hygiene.
- **Four action kinds, one shape.** Each queue item carries: `kind` (`todo`,
  `expiry_alert`, `retention_advice`, `attention_flag`), a title taken from
  the document's own extracted text where possible, an optional date, for
  retention items an `advice` (`keep`, `shred`, `trash`) plus the id of the
  rule that produced it and the one-line non-advice disclaimer (ADR-0008
  point 6), and citations: the source document id and a verbatim snippet of
  the extracted evidence (ADR-0008 point 2; page-image crops join in the
  Phase 3 UI). `status` is always `proposed`: the agent proposes, the human
  acts, and there is no destructive tool to execute anything (ADR-0008
  point 3).
- **Rule sources, all v1-mechanical:**
  - To-dos: each document's extracted `action_items`, with due dates,
    deduplicated across documents.
  - Expiry alerts: type-specific date fields (`id_document.expiry_date`,
    `policy.expiry_date`, `contract.termination_date`, `bill.due_date`)
    within a configurable look-ahead window, or already past.
  - Retention advice: a static per-type rules table in code, versioned and
    documented, cited by rule id (e.g. an id document is `keep`, never
    `trash`; a paid utility bill is `shred` after a stated period). Plain
    rules a reviewer can read and disagree with.
  - Attention flags: pipeline signals only, no content judgment in v1:
    invalid extraction, disputed or low-confidence type, past-due dates,
    expired documents. Framed per ADR-0008 point 5: the queue reports "N
    flagged, M not yet reviewed by you" and never renders an all-clear.
- **Review gating.** Items derived from a document whose reconciliation says
  `review` are grouped under "needs review first" and never presented as
  settled advice. The action layer consumes the classifier's trust signal
  instead of overriding it.
- **Surface.** `outtray actions <dir>` in the CLI: scan, plan, print the
  queue with citations. The Phase 3 UI renders the same queue object.
- **Scored like everything else.** Fixtures gain expected-action labels; an
  action-level precision/recall row joins the scoreboard and the CI replay
  gate. Because planning is deterministic, CI tests the full differentiator
  end to end with recorded extractions and no model.

## Options considered

1. **Deterministic rules over typed extractions (recommended).** Pros: the
   whole differentiator is testable in CI without a model; every piece of
   advice is explainable by pointing at a rule and a cited field; no
   injection surface in planning; nothing new resident in memory on the 8 GB
   target (ADR-0002). Cons: rules only see what extraction structured, so
   nuance in free text is missed; the rules table needs curation as document
   variety grows; advice quality is bounded by extraction quality.
2. **Local LLM planner pass.** A text model reads all extractions and drafts
   the queue. Pros: richer synthesis across documents, better phrasing,
   catches things rules never encoded. Cons: attacker-authored text feeds the
   step that writes what the human acts on, the central ADR-0008 threat; the
   output is nondeterministic, so the differentiator becomes the hardest
   thing to test and every CI run needs recordings of one more model; a third
   model joins the residency budget. Rejected for v1.
3. **Hybrid: rules build the queue, an optional model pass only polishes.**
   Titles and grouping could be rewritten by a small local model, clearly
   marked, with the rule-derived facts immutable. Deferred, not rejected:
   worth revisiting once v1 measures where rules actually fall short, and
   only within ADR-0008's delimited-data rules.

## Consequences

- The showcase argument writes itself: models are quarantined to perception
  (extract) and verification (classify); the layer users act on is
  deterministic, cited, and measured. Honest uncertainty (review gating,
  attention flags) is a feature of the queue, not a caveat in the docs.
- New core module with documented failure modes and hermetic tests; the
  fixture generator and manifest grow expected-action ground truth; the
  scoreboard and CI gate grow an action row.
- The retention rules table is a liability surface: it ships with the
  disclaimer (ADR-0008 point 6), stays deliberately small in v1, and every
  piece of advice cites its rule id so a wrong rule is traceable.
- Depends on the ADR-0009 amendment's reconciliation verdicts (#54) for
  review gating, and its quality improves further once disputed types are
  auto-corrected (#57).
