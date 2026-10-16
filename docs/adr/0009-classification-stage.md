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

## Amendment 2 (2026-10-13): the personalization loop

Status: **accepted 2026-10-13 by Claude** under the project's autonomy rules
(`.claude/CLAUDE.md`). It builds the loop this ADR's decision describes
(issue #67) and reverses nothing above.

### Decision

- **`outtray correct <file> <type>` pins a document's type.** A new
  reconciliation status, `user`, trusts the pinned type outright: no review,
  no classifier vote, on this scan and every later one. The VLM label and the
  classifier verdict stay on the record as provenance.
- **A pinned type that differs from the stored extraction forces one typed
  re-extraction** on the next scan, under the pinned type's schema, reusing
  the typed prompt from amendment 1. Relabeling alone would leave the action
  layer reading fields the extraction does not have (option 2 of amendment 1,
  rejected there for the same reason). If the typed extraction does not
  validate as the pinned type, the item keeps the pin and asks for review.
- **Each correction is a labeled example** in the encrypted `labels` table
  (ADR-0011), one per document: correcting the same document again replaces
  the earlier example rather than leaving two contradictory ones.
- **Labels are embedded from tokenized text.** The example and every
  classifier query embed `derivedText`, the flattened extraction with
  identifiers replaced by `[field]` placeholders (ADR-0011 amendment), so a
  label never carries an identifier or its last four, and queries and examples
  are the same kind of text. The classification eval embeds the same text.
- **Labels keep their text and embedding model.** `outtray correct` needs no
  model: the example is embedded lazily, the next time a scan has something
  to classify, and re-embedded once if the embedding model changes.

### Options considered

1. **Pin, re-extract under the pinned type, and learn from it
   (recommended).** Pros: the correction fixes this document's fields and
   improves the next similar one; works offline; sticky, so the user never
   corrects the same document twice. Cons: one extra vision call per
   corrected document whose type changed; a new reconciliation status that
   every consumer must handle (the CLI output and the action layer do).
2. **Only record a labeled example.** Pros: smallest change. Cons: the
   corrected document itself stays wrong until the classifier happens to
   agree, and a confident VLM label can keep winning. The user's explicit
   answer should not be a mere vote.
3. **Only pin, without learning.** Pros: no label store. Cons: drops the
   personalization half of this ADR, which is its stated promise.
4. **Embed the label at correction time.** Pros: the example is usable
   immediately. Cons: `correct` would need Ollama running for what is a pure
   bookkeeping act; lazy embedding loses nothing because nothing classifies
   until the next scan.

### Consequences

- Moving queries from `extractionText` to `derivedText` changes what the
  classifier sees for the three types that carry an identifier. Expected
  effect on accuracy is nil (a digit string carries no semantic signal, per
  ADR-0011), but the dev-run classification scoreboard must be re-run at the
  next dev-machine session to confirm it.
- The "gets better with use" claim needs its own measurement: accuracy with N
  corrections layered on the seeds. That needs live embeddings and is tracked
  as its own issue.
- When labels become mutable like this, a classifier version belongs in the
  ADR-0012 reuse rule; today a correction affects only documents classified
  after it, which is the intended behavior.

## Amendment 3 (2026-10-16): classify first when OCR text exists

Status: **accepted 2026-10-16 by Claude** under the project's autonomy rules
(`.claude/CLAUDE.md`). It builds the order this ADR's decision describes,
which amendment 1 deferred until an OCR arm existed (issue #159). The OCR
arm now exists (#8, ADR-0002 amendment 2) and so does a check that it read
the page (#163). Nothing above is reversed: without OCR the pipeline runs in
amendment 1's order, unchanged.

### Decision

- **A scan given an OCR recognizer reads each new document's text first.**
  It runs before any model loads, costs about 2 s and no model memory per
  page, and its text is never stored or chunked: it is only embedded for
  the vote. Chunks and stored text still come from the extraction.
- **Only a page the OCR actually read is classified from its text.**
  `assessReadability` (#163) decides. An unreadable page, or one the OCR
  failed on, takes amendment 1's path: extract, classify the extraction,
  reconcile, re-extract once on a confident dispute.
- **A confident vote routes.** At or above the confidence threshold the
  document goes straight to the typed prompt for the classifier's type, one
  vision call instead of up to two. A new reconciliation status, `routed`,
  records it: trusted, no review, the classifier verdict kept as provenance,
  and no VLM label, because the VLM was told the type rather than asked.
- **A typed extraction that does not come back as that type falls back** to
  the generic prompt, and the two labels are reconciled as usual. If they
  then disagree the item stays `disputed` for review without another typed
  attempt: it has had its one.
- **A vote below the threshold is a reconciliation input.** The document is
  extracted with the generic prompt and its label reconciled against the
  OCR vote: `confirmed` when they agree, `low_confidence` and review when
  they do not.
- **OCR joins the reuse key.** With OCR on, the extractor key (ADR-0012)
  adds the recognizer's key (contract, engine and flags) and a routing
  version, `classify-first-v1`, to bump when the readability thresholds or
  the routing rules change. Turning OCR on or off re-extracts every document
  once; that is the price of a key that says what an extraction depends on.
- **Opt-in until measured.** OCR routing is off unless the host turns it on.
  The CLI exposes it as a setting next to identifier storage; the app does
  not yet, since the sidecar is not packaged with it (#12).

### Options considered

1. **Route on a confident vote, reconcile otherwise (recommended).** Pros:
   it is the order this ADR accepted; a confidently known type gets its
   typed schema on the first call, so a bill mislabeled `statement` never
   needs the second call amendment 1 spends on it. Cons: on the routed path
   nothing checks the classifier. The VLM is told the type and cannot
   object, so a confident wrong vote costs that document's fields until
   someone corrects it. That risk is why it waits for a measurement before
   it becomes the default.
2. **Use the OCR vote only as a reconciliation input.** Always extract with
   the generic prompt, then reconcile against a vote taken from the OCR
   text. Pros: two independent labels on every document, where today the
   classifier embeds the VLM's own extraction and shares its mistakes. Cons:
   saves no vision call and keeps the second call on every dispute; it does
   not do what the ADR decided.
3. **Feed the OCR text into the extraction prompt.** Pros: likely the
   largest accuracy gain, since the small VLM would read printed text it now
   has to recognize itself. Cons: a new prompt that must be recorded and
   measured on the dev machine, and a longer prompt where prefill is already
   89% of the time (`docs/evals/cost-dashboard.md`). A separate experiment,
   not part of routing.
4. **Turn it on automatically whenever the sidecar is found.** Pros: no
   setting. Cons: building the sidecar for the OCR eval would silently
   change every scan and re-extract the whole store. Opt-in keeps that a
   choice until the numbers are in.

### Consequences

- Queries and examples are no longer the same kind of text on the OCR path:
  the query is raw OCR text, the seeds are keyword lists and the user's
  corrections are `derivedText` (amendment 2). Whether the vote holds up
  across that gap is the first thing to measure, on the dev machine with
  live embeddings, before routing becomes the default. If it does not,
  corrections can also keep the OCR text they were made from.
- OCR text is embedded with full identifiers in it, because tokenizing
  needs the extracted value and none exists yet. The embedding goes to the
  loopback-only local runtime that already sees the image, and neither the
  text nor its vector is stored, so the threat model does not change.
- Engine revision (the OS's Vision version) is not in the key, since it is
  known only after OCR runs; an OS update does not invalidate stored
  extractions.
- Stage order with OCR: OCR, embedder (vote), VLM (extract), embedder
  (vote on what OCR could not read), VLM (typed retries), embedder (index).
  Still batched by model; never two resident at once.
