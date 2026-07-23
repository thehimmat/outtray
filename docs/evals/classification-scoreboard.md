# Classification scoreboard

Document-type classification accuracy: the one-shot VLM label vs the ADR-0009
on-device k-NN classifier run over the VLM's extraction text. Measures whether
the cheap classifier corrects the VLM's type errors (issue #37).

Model `qwen3-vl:2b` (replayed) + embedder `nomic-embed-text` (live). Generated
by `node packages/evals/scripts/classify.mjs`. Not yet CI-replayed: embedding
record/replay is a follow-up, so these are dev-run numbers.

| Document type | VLM type accuracy | Classifier accuracy |
| --- | --- | --- |
| bill | 0/2 (0%) | 2/2 (100%) |
| id_document | 2/2 (100%) | 2/2 (100%) |
| letter | 2/2 (100%) | 2/2 (100%) |
| policy | 2/2 (100%) | 2/2 (100%) |
| receipt | 2/2 (100%) | 2/2 (100%) |
| **overall** | **8/10 (80%)** | **10/10 (100%)** |

The classifier is seeded only (no user corrections yet); personalization from
the ADR-0008 correction loop layers on top.
