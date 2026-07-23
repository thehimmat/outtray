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

## Amendment (2026-07-22): live-pipeline order and reconciliation

Status: **accepted 2026-07-22** on owner sign-off (issue #54). Owner comment:

> makes sense. Let's go ahead with this

The accepted reconciliation is option 1 below: on a confident disagreement,
re-extract once under the classifier's type-specific schema (issue #57).

Wiring the classifier into the live `outtray scan` pipeline (issue #30)
surfaced two points the accepted text above does not settle.

### 1. The pipeline order is inverted until an OCR arm exists

The accepted decision says the classifier "runs first and routes each document
to its type-specific extraction schema". That presumes document text to embed
before the VLM runs. No such text exists yet: the OCR arm (Apple Vision
sidecar, issue #8) is unbuilt, so the only text source is the VLM extraction
itself.

The live pipeline therefore runs, per scanned folder:

1. VLM extracts every document (one model resident, ADR-0002).
2. The embedder loads once, embeds each document's extraction text plus the
   classifier seeds, and the k-NN classifier labels each document.
3. Each document's VLM type and classifier type are reconciled (below).

Stages are batched by model, not interleaved per document, so the VLM and the
embedder are never resident together and the runtime swaps models twice per
scan, not twice per document. The classifier is a verifier today; it becomes
the router the accepted text describes once OCR text is available before
extraction.

### 2. Reconciliation when the labels disagree

Measured basis (dev run, replayed `qwen3-vl:2b` + live `nomic-embed-text`,
N=10 fixtures, seeds only): with k=3 neighbors, every correct classification
scores confidence 0.67-0.73, including both bill fixtures the VLM mislabels
as `statement`. With k=5 the winning share never exceeds 0.49, because only 2
seeds per type exist and the vote share is capped by seed count. So the
classifier runs at **k=3** with a **0.6 confidence threshold**, both
provisional: N is small, no misclassification has been observed yet to
calibrate the low side, and both constants are re-measured by the
classification scoreboard as fixtures and user corrections grow.

The proposed routing:

| Classifier vs VLM | Confidence | Outcome |
| --- | --- | --- |
| agrees | any | type confirmed, no review needed |
| disagrees | >= 0.6 | prefer the classifier: re-extract once (the decision below) |
| disagrees | < 0.6 | effective type `unknown`, routed to human review (ADR-0008) |
| classifier unavailable | - | single-stage VLM label, degradation noted in the report |

### Options considered for the confident-disagreement branch

1. **Re-extract once under the classifier's type-specific schema
   (recommended).** The document goes back to the VLM with the constrained
   `format` narrowed to the winning type's branch of the ADR-0004 union and a
   prompt that names the type. Pros: the corrected document is contract-valid
   with the right fields, so a bill mislabeled `statement` gains its
   `amount_due` and `due_date`, which is what the action layer actually needs.
   The cost lands only on disputed documents (2 of 10 fixtures today, ~3 s
   each on the 8 GB Air). Cons: a second prompt variant enters the
   record/replay contract and must be recorded; scan latency grows on
   disputed documents. Guards: exactly one re-extraction, never a loop; if
   the re-extraction fails validation, the item routes to human review with
   both labels shown.
2. **Relabel without re-extracting.** Pros: free. Cons: the extraction
   contract is a discriminated union, so the old fields do not match the new
   type; a statement-shaped extraction relabeled `bill` still has no amount
   due or due date. The action list gains nothing, which defeats the purpose.
   Strictly worse than routing to review.
3. **Flag for human review, never auto-correct.** Pros: simplest, zero model
   cost, safe under ADR-0008. Cons: the user does the correcting by hand, and
   the measured 80% to 100% classification win stays theoretical. This is the
   interim behavior of the wiring PR, so signing off option 1 upgrades one
   branch of the routing rather than reworking the pipeline.

### Consequences of the amendment

- A second prompt version (typed re-extraction) joins the record/replay
  contract; the classification scoreboard gains a reconciled-type column so
  the end-to-end win is measured, not asserted (issue #52 covers CI replay).
- Scan output grows a reconciliation verdict per document (confirmed,
  disputed, low-confidence, unclassified) that the action layer (ADR-0010)
  consumes as its trust signal.
- When the OCR arm lands, the order question reopens: classify-first becomes
  possible and cheaper, and this amendment's inverted order becomes the
  fallback path for image-only flows.
