# ADR-0009: Local-personalization document-type classification stage

Status: **accepted 2026-07-22** on owner sign-off (issue #47). Owner comment:

> yes. this is the right approach. approved

## Context

Phase 1 runs the VLM once per document to classify *and* extract in a single
pass. The first scoreboard (`docs/evals/scoreboard.md`) shows the cost of that:
overall recall 77%, but **bill recall 0%** because `qwen3-vl:2b` files utility
bills under `statement` (issue #37). The extraction itself is right; the
classification is not, and nothing about the pipeline learns from that mistake
or from the user correcting it.

Two problems, then: classification is the weak link, and the product is closer
to a stateless OCR reader than to something that gets better with use (the
concern in issue #30). The owner's decision on #30 is **local personalization**:
learn on-device from the user's own documents, never from a shared corpus, until
and unless a clean, transparent data approach exists (parked).

The retrieval work in Phase 2 (ADR-0005) gives us the pieces to do this cheaply:
a local embedding provider and an in-TypeScript cosine scan already exist.

## Decision (proposed)

- **Two-stage pipeline.** A fast document-type classifier runs first and routes
  each document to its type-specific extraction schema (ADR-0004). The
  expensive VLM pass narrows to the chosen type, and confidently-known types can
  use a cheaper path.
- **Classifier: on-device k-NN over document embeddings.** Embed the document
  (reusing the ADR-0005 embedding provider + cosine scan) and classify by
  nearest labeled neighbors. Seeded with a few canonical labeled examples per
  type so it works on day one, then improved by the user's own data.
- **Personalization from the human-acts loop (ADR-0008).** Every keep/shred/
  correction and every accepted or edited extraction is a labeled example,
  stored locally, added to the neighbor set. The classifier adapts to the
  user's recurring documents and layouts. All labels and vectors stay on the
  machine (ADR-0007).
- **Confidence routes review.** The classifier's neighbor agreement is a
  confidence signal: low-confidence documents route to human review (ADR-0008)
  or to a full-VLM re-classification, rather than silently guessing.
- **Scored like everything else.** Classification accuracy joins the scoreboard
  as its own metric (a confusion matrix over the fixture types), so this is
  measured, not asserted.

## Alternatives considered

- **Keep the one-shot VLM.** Rejected: it misclassifies (the bill/statement
  gap) and cannot learn from corrections.
- **Fine-tune a local model per user.** Rejected: no training infrastructure,
  and fine-tuning is out of budget on the 8 GB target (ADR-0002). k-NN over
  embeddings gets most of the benefit with none of the training cost.
- **Ship a global classifier trained on a document corpus.** Deferred, not
  rejected: it needs collected data and the privacy approach the owner parked in
  #30. Revisit far down the road if that changes.

## Consequences

- Reuses the Phase 2 embedding + cosine infra; the new code is the label store,
  the k-NN vote, and the routing.
- Adds a local, encrypted (ADR-0007) store of user corrections as training
  signal: the product improves with use without anything leaving the machine.
- The scoreboard gains a classification-accuracy row; the bill/statement gap
  (#37) becomes a tracked number that personalization should close over time.
- Interacts with ADR-0002 (models), ADR-0004 (the type contract it routes to),
  ADR-0005 (reused retrieval infra), and ADR-0008 (corrections as labels).
- Cold-start quality depends on the seed examples; the synthetic-to-real gap
  applies (METHODOLOGY.md) and is measured before any claims.
