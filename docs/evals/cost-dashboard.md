# Cost dashboard

What one extraction costs on the dev machine (a 2022 MacBook Air, 8 GB),
from the timings Ollama reported when each fixture's extraction was
recorded. Load and generating are reported by the runtime. **Prefill**
(reading the prompt and the page image) is the rest of the wall time, taken by difference.
Regenerate with `pnpm eval:cost`; CI replays it and fails on drift.

Generated at commit `5303b0149021` over 10 fixture extractions with `qwen3-vl:2b`.

## Headline

| | Median (s) |
| --- | --- |
| Model load | 0.2 |
| Prefill (prompt and image) | 29.1 |
| Generating the answer | 2.3 |
| **Total per document** | **31.8** |

- **Prefill is 89% of all the time.** The model writes about
  100 tokens at roughly 43 tokens per second, a couple of seconds; the rest
  is reading a prompt of about 3,300 tokens, most of them the page image,
  at a median of about 118 prompt tokens per second (see below:
  that rate is far below what the memory spike measured).
- Slowest call: id_document-001, 44.6 s.

## Per fixture

| Fixture | Load (s) | Prefill (s) | Generate (s) | Total (s) | Prefill share | Prompt tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bill-001 | 10.4 | 30.1 | 2.4 | 42.9 | 70% | 3319 | 104 |
| receipt-001 | 0.2 | 38.3 | 2.1 | 40.6 | 94% | 3319 | 86 |
| letter-001 | 0.3 | 38.7 | 2.1 | 41.0 | 94% | 3319 | 91 |
| id_document-001 | 0.5 | 41.9 | 2.2 | 44.6 | 94% | 3319 | 91 |
| policy-001 | 0.2 | 23.1 | 3.7 | 27.0 | 86% | 3319 | 163 |
| bill-002 | 0.2 | 27.0 | 2.5 | 29.7 | 91% | 3319 | 113 |
| receipt-002 | 0.2 | 22.7 | 1.8 | 24.6 | 92% | 3319 | 78 |
| letter-002 | 0.1 | 28.2 | 2.6 | 30.9 | 91% | 3319 | 108 |
| id_document-002 | 0.4 | 30.1 | 2.2 | 32.7 | 92% | 3319 | 93 |
| policy-002 | 0.2 | 23.8 | 3.6 | 27.6 | 86% | 3319 | 159 |

## What this means

- **Reading the input is the cost, not writing the answer.** Generating
  takes about 2 s; prefill takes the rest.
- **The prefill rate is the open question.** The memory spike measured this
  same model reading its prompt at about 1,830 tokens per second, warm and
  fully on the GPU (`docs/evals/model-memory-spike.md`). These recordings
  read at about 118. The fixtures (1632x2000) have four times the
  spike page's pixels, which explains about three times the tokens but not a
  rate about 15 times slower. The likeliest cause is the larger context
  spilling off the GPU, as the 4b model did in the spike; contention at
  recording time is the other candidate. #152 measures it on the Air.
- **Either way, the levers are on the input side.** Keep the context on the
  GPU (a smaller image, a smaller context, flash attention), or send less
  image by reading text with the OCR arm (#8). A faster decoder would save
  about 2 s.
- **The incremental scan (ADR-0012) already removes the cost for unchanged
  documents**: they make no model call at all on the next scan.

## Caveats

- **One run per fixture, recorded once.** No noise floor yet (the
  methodology asks for 5 live runs); the machine's load at recording time is
  not known, and the spike found heavy swap on this machine is normal.
- **Model load appears once.** Calls after the first find the model resident;
  a cold start shows as one call's load time.
- **Prefill is by difference where not measured**, so it includes any runtime
  overhead outside load and generating. Recordings now keep Ollama's
  `prompt_eval_duration` (#150); the next `pnpm eval:record` on the dev
  machine makes every row a measured figure.
- **Ten synthetic single-page fixtures.** Real multi-page documents cost
  proportionally more.
