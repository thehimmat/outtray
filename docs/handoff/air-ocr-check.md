Prompt for a Claude Code session on the 2022 MacBook Air, in a fresh
worktree of thehimmat/outtray on an up-to-date main. Paste everything below
the line.

---

Read `.claude/CLAUDE.md`. Then check, on this Mac, the OCR classify-first
work merged in #165 and #166 (ADR-0009 amendment 3, issue #159), and take
the measurement #159 is still open for. Follow the repo's conventions
(TDD, no em dashes, branch `feat/<short-name>`, PR with a Decisions
section). Do not run Ollama at the same time as a build.

## 1. Build and sanity-check (stop and report if any step fails)

1. `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
2. `swift build -c release --package-path packages/ocr-vision`, then
   `export OUTTRAY_OCR_BINARY=$PWD/packages/ocr-vision/.build/release/outtray-ocr`
3. `$OUTTRAY_OCR_BINARY --contract` prints `ocr-v1`.
4. `ollama list` shows `qwen3-vl:2b` and `nomic-embed-text`. Pull a model
   only if it is missing.

## 2. End to end through the CLI (the real store, synthetic fixtures only)

The store is the real one in `~/Library/Application Support/outtray`.
Switching `ocr` changes every stored document's extractor key, so record
the current setting first and restore it at the end. Expect a Keychain
prompt per command if the app created the key (#134).

1. `node packages/cli/dist/main.js settings`: note the current `ocr` value.
2. `node packages/cli/dist/main.js settings ocr on`, then run it again and
   confirm it prints `OCR is already on.`
3. Copy the fixtures so the scan sees images only:
   `mkdir -p /tmp/ocr-check && cp packages/evals/fixtures/synthetic/*.png /tmp/ocr-check/`
4. `/usr/bin/time -l node packages/cli/dist/main.js scan /tmp/ocr-check`.
   Record wall time, peak memory, and each document's type tag. A routed
   document reads `<type>, read from its text <confidence>`. Count routed
   documents and vision calls. Ollama's log, or the scan time divided by
   about 30 s, is enough to tell one vision call from two.
5. Run the same scan again. It should reuse everything: no model call,
   seconds not minutes.
6. Failure path: `OUTTRAY_OCR_BINARY=/nonexistent node packages/cli/dist/main.js scan /tmp/ocr-check`
   must exit 1 with `OCR is on and cannot run here`, without the Ollama
   hint and without any model call.
7. `node packages/cli/dist/main.js actions /tmp/ocr-check`: the queue looks
   sane. Routed documents raise no type flags.
8. Restore the setting from step 1 (`settings ocr off` if it was off).

## 3. The measurement #159 waits on

Extend the classification eval (`packages/evals/src/classify-eval.ts`,
`scripts/classify.mjs`, `pnpm eval:classify`) with an OCR-vote column.
Classify each fixture from its recorded OCR text
(`packages/evals/recordings/ocr/default`, through `ocrPlainText`) with the
live `nomic-embed-text` embedder, `CLASSIFIER_K`, the seeds, and
`CONFIDENCE_THRESHOLD`. Report:

- accuracy of the OCR vote per type, next to the existing VLM, classifier
  and reconciled columns;
- how many fixtures would be routed (vote at or above the threshold), and
  how many of those votes are wrong. A wrong routed vote costs that
  document its fields, so this is the number that decides the default;
- the vote confidences, since the threshold was calibrated on extraction
  text, not OCR text.

Write the failing test first, against a fake embedder, as the existing
classify-eval tests do. Regenerate `docs/evals/classification-scoreboard.md`
and add the result to #159.

## Then decide

- Every routed vote right, and accuracy at least the classifier's 10/10:
  propose making `ocr` the default in a follow-up PR. Changing a default is
  Claude's call per CLAUDE.md, but write it up as an ADR-0009 amendment 3
  addendum with the numbers.
- Any routed vote wrong: leave it off. File an issue with the
  misclassified fixtures and the options: raise the threshold for the OCR
  path, or keep the OCR text of corrections as labels (amendment 3,
  Consequences).

Also note in the PR: the #166 description says `pnpm cli`, but no such
script exists. The CLI runs as `node packages/cli/dist/main.js`.
