# ADR-0002: Local inference runtime and models

Status: accepted. Date: 2026-07-21.

## Context

All inference runs locally by default; that is the product's headline claim.
The binding constraint is 8 GB unified memory shared with macOS (~2.5-3 GB),
an editor, and the app itself, leaving roughly a **4 GB peak inference
budget**. Verified before this decision: the models named in early drafts are
infeasible on this machine. Under Ollama, `qwen2.5vl:7b` is reported at 15-17
GB resident (KV cache pre-allocated against its 128K declared context;
ollama/ollama#14312) and Llama 3.2-Vision 11B needs ~8 GB for Q4 weights
alone. Both are also generations behind mid-2026 releases.

## Decision

- **Runtime: Ollama.** On this machine that is the llama.cpp engine path
  (Ollama's MLX backend is gated to Macs with more than 32 GB). Hard
  requirement the runtime must satisfy: structured outputs against a JSON
  schema, which our Zod schemas compile into (ADR-0004).
- **Model lineup (candidates, decided by the eval harness, not by taste):**
  - VLM arm: **Qwen3-VL-4B** (3.3 GB on Ollama) primary, **Qwen3-VL-2B**
    (1.9 GB) fast arm, Gemma 4 E4B-class as a comparison arm.
  - Document-specialist arm: **granite-docling-258M** (GGUF) in the stage-1
    bakeoff.
  - 7B+ local models are out of scope on this hardware; the cloud provider
    (ADR-0003) is the only path to bigger models.
- **OCR arms for cross-validation:**
  1. **Apple Vision framework** (RecognizeDocumentsRequest, with
     VNRecognizeTextRequest fallback) via a small Swift sidecar returning
     JSON on stdout: ships with macOS, near-zero memory, returns document
     structure. Primary deterministic arm. The sidecar's output contract is
     defined with a Zod schema like everything else.
  2. **Tesseract**: cross-check arm (prior experience from the noise-monitor
     project) and the only portable arm for an eventual Windows/Linux port.
  Agreement between arms feeds per-field confidence scores.
- **One resident model at a time.** Pipeline stages are strictly sequential
  per batch; Ollama `keep_alive` is managed so the previous model is evicted
  before the next loads. Batch order is "parse all pages, then extract all
  fields" to avoid model-swap thrash.
- **Peak RSS and tokens/sec are instrumented from the first pipeline commit**;
  memory is the number that decides every future model choice.

## Consequences

- A Phase 0/1 memory spike (pull candidates, run one real document, record
  `ollama ps` and throughput) converts the biggest schedule risk into
  measured data on day one; the measurements feed the "what local inference
  actually costs on a MacBook Air" writeup.
- Ollama's unauthenticated localhost API is a trust boundary: the app
  preflights that the endpoint is loopback and refuses to send documents
  anywhere else (see THREAT_MODEL.md). The ModelProvider seam (ADR-0003) is
  the escape hatch to an in-process runtime if that exposure becomes
  untenable.

## Amendment (proposed 2026-07-22, PENDING OWNER SIGN-OFF, issue #18)

Status: **proposed, not yet accepted.** Do not build Phase 1 on this until
signed off. Evidence: the issue #5 memory spike,
`docs/evals/model-memory-spike.md` (N=1 document, defaults, machine under load).

The spike measured the candidates on the 8 GB reference target and revises the
"Decision" section's lineup as follows:

- **Phase 1 local default becomes `qwen3-vl:2b`**, not `qwen3-vl:4b`. On the
  8 GB Air, 2b is 2.0 GB resident and loads 100% onto the Metal GPU, returning
  a correct, schema-valid extraction in ~3 s. `qwen3-vl:4b` is 4.0 GB (4096
  ctx) / 4.6 GB (8192 ctx) resident and spills ~30% to CPU, collapsing prompt
  throughput to ~28 tok/s and driving the machine into swap; a single page took
  ~60 s. 2b is the default; 4b is the accuracy-escalation / cloud-parity arm,
  not the always-on local model. Revisit 4b's local viability under issue #15
  (q8_0 KV cache).
- **`granite-docling-258M` is confirmed as the OCR/structure arm, not an
  extractor.** It is the cheapest (0.46 GB) and fastest and the only candidate
  whose JSON came back in the `content` channel, but it misclassified the
  document and produced empty/garbled semantic fields. It feeds cross-arm
  confidence (as this ADR already positions it), not the extraction decision.
- **New runtime requirement (issue #19).** Qwen3-VL is a reasoning model; on
  Ollama 0.32.1 its format-constrained JSON is emitted into `message.thinking`,
  not `message.content`. The extractor must send `think: false` and read JSON
  from `content` with a `thinking` fallback, or it gets empty / truncated
  output.
- **Portability note (issue #20).** 2b is the right default for the 8 GB floor,
  but the shipped downloadable app should select the local model by available
  memory rather than hardcode 2b (4b or larger on 16 GB+). Likely ADR-0009.

Cross-reference: this also resolves the ADR-0004 open question. `z.toJSONSchema()`
on a `type`-discriminated union compiled and produced valid single-branch output
on all three models, so the classify-then-extract fallback is not required for
Phase 1 (kept as a documented contingency).
