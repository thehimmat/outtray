# Model memory spike: candidate VLMs on the 8 GB Air

Status: run 2026-07-22. Issue #5. Feeds ADR-0002 (model lineup) and resolves
the ADR-0004 open question on discriminated unions. This is the first
scoreboard-adjacent data and seeds the "what local inference actually costs on
a MacBook Air" post.

**These are single-page, single-document numbers from one spike run, not a
scored eval.** They exist to retire the biggest schedule risk (local-model
wrangling) with measured data and to set the Phase 1 default. Field-level
accuracy is scored later, against the synthetic fixture set, by the Phase 1
eval harness.

## TL;DR

- **Phase 1 default: `qwen3-vl:2b`.** It is the only candidate that both fits
  the ADR-0002 4 GB budget with room to spare (2.0 GB resident, runs 100% on
  the GPU) and returns a correct, schema-valid extraction in a few seconds.
- **`qwen3-vl:4b` is the accuracy ceiling, not the default.** At 4.0 GB (4096
  ctx) / 4.6 GB (8192 ctx) resident it spills off the GPU to CPU on this
  machine and drives the system into heavy swap; a single page took ~60 s and,
  under other load, minutes. Keep it as the escalation / cloud-parity arm, not
  the always-on local model.
- **`granite-docling-258M` is not a semantic extractor.** It is tiny (0.46 GB)
  and fast (92 tok/s), and it is the one model whose JSON came back in the
  right channel, but it misclassified the document and produced empty/garbled
  fields. It belongs in the OCR/structure arm (ADR-0002 cross-validation), not
  as the extraction model.
- **Two findings that change how the pipeline must be written (details below):**
  1. `z.toJSONSchema()` on a discriminated union compiles and works on Ollama.
     The ADR-0004 fallback (classify-then-extract) is **not** forced on us.
  2. On Qwen3-VL + Ollama 0.32.1, format-constrained JSON is emitted into
     `message.thinking`, **not** `message.content`. The client must read the
     thinking channel (or the pipeline gets empty output).

## Environment

- 2022 MacBook Air, Apple Silicon, 8 GB unified memory (the ADR-0002 target).
- Ollama 0.32.1 (Homebrew), llama.cpp engine path, default flags
  (`OLLAMA_FLASH_ATTENTION=false`, default KV cache type). Plain `ollama serve`,
  no memory-saving flags, so these are honest defaults, not a tuned best case.
- Machine was **not** pristine: other apps resident and ~12-16 GB of
  compressed swap committed during the run. That is realistic for the target
  user but means the throughput numbers for the model that does not fit
  (`qwen3-vl:4b`) are pessimistic and high-variance. The resident-size and
  processor-split numbers are stable regardless.

## Method

- **Document:** one synthetic single page, a US vehicle-registration renewal
  notice (`spike/renewal-notice.html`, rendered to an 816x1000 PNG). Chosen
  because it carries exactly the fields the product must extract: an expiry
  date, an amount due, a hard deadline, a late-fee, and a reference number. It
  is synthetic (no real PII); the identity and numbers are invented.
- **Task:** classify into a document type and extract fields, with deadlines
  pushed into `action_items[]` normalized to ISO 8601.
- **Schema:** a Zod 4 `z.discriminatedUnion("type", ...)` over `bill`,
  `letter`, `id_document`, `unknown` (the ADR-0004 shape: a shared base plus a
  `type` discriminant, each branch with its own fields). Compiled with
  `z.toJSONSchema()` (emits `oneOf` with a `const` discriminant per branch) and
  passed verbatim as Ollama's `format`. Full schema: `spike/union.schema.json`.
- **Harness:** `spike/spike.mjs` (throwaway, not pipeline code). Streams
  `/api/chat`, accumulates output, validates the result back through the same
  Zod schema (ADR-0004: constrained decoding guarantees shape, not semantics,
  so parse-time validation stays). Timing is taken from Ollama's own
  nanosecond counters; resident memory from `ollama ps` while the model is
  loaded. `temperature: 0`, `num_ctx: 4096`, thinking disabled.

## Results

### Memory and throughput (one page)

| Model | Resident | Processor split | Load | Prompt eval | Gen | Wall (1 page) |
|---|---|---|---|---|---|---|
| `qwen3-vl:2b` | **2.0 GB** @4096 | **100% GPU** | 0.15 s warm | 1133 tok @ ~1830 t/s warm | 129 tok @ 49 t/s | **3.4 s** warm |
| `qwen3-vl:4b` | **4.0 GB** @4096; 4.6 GB @8192 | **31% / 69% CPU/GPU** | ~15 s cold | 1133 tok @ 28 t/s | 172 tok @ 17 t/s | **~60 s** |
| `granite-docling-258M` | **0.46 GB** @4096 | **100% GPU** | 1.6 s | 1218 tok @ 410 t/s | 154 tok @ 92 t/s | **7 s** |

The processor split is the headline. `2b` and `granite` load entirely into the
Metal GPU allocation. `4b` does not fit and llama.cpp offloads ~30% of the
model to CPU, which is why its prompt-eval throughput collapses to 28 tok/s
(the ~1130-token image prompt alone then costs ~40 s) and why loading it pushed
the 8 GB machine deep into swap.

### Structured output

| Model | Union grammar compiled | JSON valid vs Zod | JSON channel | done_reason |
|---|---|---|---|---|
| `qwen3-vl:2b` | yes | **yes** | `thinking` (quirk) | stop |
| `qwen3-vl:4b` | yes | **yes** | `thinking` (quirk) | stop |
| `granite-docling-258M` | yes | yes (shape only) | `content` (correct) | stop |

### Extraction quality (semantic, eyeballed, N=1)

| Field | Ground truth | `2b` | `4b` | `granite` |
|---|---|---|---|---|
| type | bill | bill correct | bill correct | **letter wrong** |
| amount_due | $301.00 | $301.00 | $301.00 | (n/a on wrong branch) |
| due_date (ISO) | 2026-08-31 | "August 31, 2026" (not normalized) | **2026-08-31** | not normalized |
| late_fee | $54.00 | $54.00 | $54.00 | (n/a) |
| payee / issuer | State DMV | "JORDAN A RIVERA" (addressee, not issuer) | **State DMV correct** | garbled |
| summary | (a sentence) | "$301.00" (weak) | **full sentence** | empty |

`4b` is clearly the most accurate (correct issuer, native ISO date, real
summary). `2b` gets classification and the money/date fields right but is
sloppier on summary and issuer. `granite` reads text off the page but cannot
triage it: it took the `letter` branch and turned the barcode into a `sender`.

## The two findings

### 1. Discriminated unions work; the ADR-0004 fallback is not forced

ADR-0004 flagged an open question: whether `z.toJSONSchema()` output for a
discriminated union would be accepted by Ollama's grammar compiler, with a
planned fallback of "classify first with an enum-only schema, then extract."

All three models compiled the `oneOf`-with-`const`-discriminant schema and
produced JSON that (a) parsed and (b) selected exactly one branch with that
branch's fields present (`bill` -> `payee`/`amount_due`/`late_fee`; `letter` ->
`sender`/`subject`). The union is safe to use directly. We keep the
classify-then-extract fallback documented as a contingency but do not need to
build it for Phase 1.

### 2. Qwen3-VL emits constrained JSON into the thinking channel

Qwen3-VL is a reasoning model. On Ollama 0.32.1, when `format` is set, the
generated JSON is routed to `message.thinking`, leaving `message.content`
**empty**. A first-cut client that reads only `content` sees nothing and, with
thinking left on and a small `num_ctx`, the model spends its whole token budget
"thinking" and gets truncated to invalid JSON (observed: 2961 generated tokens,
`done_reason: length`, empty content). Disabling thinking and reading the
thinking channel as a fallback both fix it. The Phase 1 extractor must:

- set `think: false` on Qwen3-VL requests, and
- read the JSON from `content` **or** `thinking` (content preferred).

This is a concrete, easy-to-miss integration hazard that the memory spike
surfaced before any pipeline code was written, which is exactly its job.

## What this says about the Phase 1 default

Ranked by fit for the always-on local extraction stage on this hardware:

1. **`qwen3-vl:2b` (default).** Fits the budget with headroom (2.0 GB, 100%
   GPU, ~2 GB of the 4 GB envelope free for the OCR arm and app), seconds per
   page, correct classification and correct money/date extraction. Its
   weaknesses (summary phrasing, issuer-vs-addressee) are prompt- and
   normalization-layer problems, not capability gaps.
2. **`qwen3-vl:4b` (accuracy escalation, not default).** Best extraction, but
   4.0-4.6 GB resident means it does not fit the GPU on an 8 GB machine while
   anything else is running; it spills to CPU and swaps. Reserve it for a
   "low-confidence, re-run bigger" path or route those pages to the cloud
   provider (ADR-0003). Revisit if a smaller-context or more-quantized build
   lands under ~3 GB.
3. **`granite-docling-258M` (OCR/structure arm, not extraction).** Cheapest and
   fastest and the only clean JSON channel, but it does not do semantic
   triage. It fits ADR-0002's deterministic cross-validation arm alongside
   Apple Vision, feeding per-field confidence, not the extraction decision.

Net: **build the Phase 1 extraction pipeline around `qwen3-vl:2b`, keep the
schema as a real discriminated union, wire in the `think:false` +
thinking-channel handling from the first commit, and hold `qwen3-vl:4b` as the
escalation arm.**

## Caveats

- N=1 document, one run per model; semantic quality is eyeballed, not scored.
  The point was memory and feasibility, and the structured-output contract, not
  accuracy ranking. Field-level scoring waits for the fixture set.
- Throughput for `4b` is pessimistic (machine under load + CPU spill) and
  high-variance; treat it as "too slow to be the default here," not as a precise
  tok/s figure.
- Defaults only: no flash-attention, no KV-cache quantization. `q8_0` KV cache
  would cut `4b`'s footprint and is worth a follow-up measurement, but does not
  change the ranking.

## Reproduce

See `spike/`:

```
# 1. render the synthetic page (deterministic from the committed HTML)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=816,1000 --screenshot=renewal.png \
  "file://$PWD/spike/renewal-notice.html"
sips --resampleHeight 1000 renewal.png --out renewal-1000.png

# 2. deps for the harness (isolated; not part of the workspace)
npm init -y && npm i zod@^4

# 3. run each candidate; capture `ollama ps` in another shell while it runs
node spike/spike.mjs qwen3-vl:2b renewal-1000.png
node spike/spike.mjs qwen3-vl:4b renewal-1000.png
node spike/spike.mjs hf.co/ibm-granite/granite-docling-258M-GGUF:latest renewal-1000.png
```

Captured per-model outputs are committed alongside as
`spike/result-*.json`.
