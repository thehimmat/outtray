---
title: Evals that run in CI without ever calling a model
status: draft
phase: 1
audience: engineers building on local LLMs
---

# Evals that run in CI without ever calling a model

*Draft. Owner publishes.*

Outtray is a local-first document assistant: point it at a folder of unsorted
documents and it produces a reviewed action list. The whole pipeline runs on a
2022 MacBook Air with 8 GB of memory, against a 4B vision-language model. That
constraint shaped everything, including how the project runs its evals.

Here is the problem. If your quality gate calls a model, it is slow,
nondeterministic, and impossible to run in CI where there is no GPU and no
model. So most LLM projects either skip automated quality gates or run them
manually and hope. Outtray does neither. Every pull request recomputes per-field
precision and recall over a labeled fixture set, and it does so **without ever
calling a model**, by replaying recorded model outputs.

## The contract key

The core idea is small. A model call is a pure function of its inputs: the
prompt, the images, the model, the decoding parameters, and the output schema.
Hash all of that into a single key, and a recorded output is valid exactly as
long as none of those inputs changed.

```
contractKey = sha256(
  model,
  sha256(prompt),
  sha256(images),
  sha256(jsonSchema),   // z.toJSONSchema(...) of the Zod contract
  canonicalize(options) // temperature, num_ctx, ...
)
```

On the dev machine, `pnpm eval:record` runs the real model and writes each
response to `recordings/<key>.json`. In CI, the same harness runs in replay
mode: it recomputes each key and reads the committed recording. A missing
recording is a hard error, not a fallback to a live call:

> Stale or missing recording for contract `a1b2...`. Run `pnpm eval:record`.

That single rule is what makes the replay trustworthy. If you change the prompt,
the schema, the model, or a decoding parameter, the key changes, the recording
is missing, and CI tells you to re-record. Replay therefore proves that the
committed recordings still correspond to the current pipeline, and that the
parsing, validation, and scoring around them all still work.

## What the harness actually scores

The same `extract()` the product uses is driven over a set of synthetic
fixtures. Each fixture is generated deterministically from a seed: an HTML
render source, a rendered page image, and a set of ground-truth labels, all
checksummed in a manifest so CI fails on any unmanifested or altered file. No
real personal documents are ever committed; the invented identities are the test
set.

Scoring is per field, per document type, reported as raw counts rather than bare
percentages, because at ten fixtures a percentage is a lie with a decimal point.
Values are normalized first (ISO dates, currency, case and whitespace) so that
"August 31, 2026" and "2026-08-31" count as the same answer. A wrong value
counts against both precision and recall. Each proportion carries a Wilson
interval, which stays honest at small N.

## The first scoreboard

Here is the first committed scoreboard for `qwen3-vl:2b`, the 2B model that fits
the memory budget:

| Document type | Precision | Recall |
| --- | --- | --- |
| id_document, letter, policy | 100% | 100% |
| receipt | 7/7 (100%) | 7/8 (88%) |
| bill | 0/2 (0%) | 0/10 (0%) |
| **overall** | **37/39 (95%)** | **37/48 (77%)** |

The bill row is the interesting one, and it is why you build the harness before
you trust your eyes. The model reads the bills correctly: it extracts the
amount, the due date, and the issuer. It just files them under `statement`
rather than `bill`. That is a taxonomy confusion, not an OCR failure, and the
fixtures do not help: a utility bill often says "Statement" across the top. The
scoreboard surfaced this on day one, with a filed follow-up, instead of it
hiding behind a confident demo.

## Why this is worth the ceremony

Three properties fall out of the design:

1. **CI is fast and deterministic.** No model, no GPU, no flakes. The eval is
   just replay plus arithmetic.
2. **Drift cannot hide.** You cannot change a prompt and forget to re-measure;
   the missing recording stops the build.
3. **The numbers are real and honest.** They come from an actual model run,
   committed and checksummed, and they show the weak spots instead of hiding
   them.

The measurement layer was built before the pipeline was tuned, which is the
whole point of eval-first development: you cannot improve what you refuse to
measure, and you cannot trust a number your CI cannot reproduce.

---

*Follow-up posts: what local inference actually costs on an 8 GB Air, and the
two-stage-classifier idea for closing the bill/statement gap.*
