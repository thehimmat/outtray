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
