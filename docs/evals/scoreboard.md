# Scoreboard

Append-only history of extraction quality on the committed synthetic fixture
set. Numbers are per-field precision/recall as raw counts (METHODOLOGY.md);
recall shows a 95% Wilson interval. Regenerate with `pnpm eval:record`.

Stamps: model `qwen3-vl:2b`, prompt `8e849caa28e5`, fixtures `2e664cbe5d0a`, commit `75ab7d0bf5ca`.

| Document type | Precision | Recall (95% CI) |
| --- | --- | --- |
| bill | 0/2 (0%) | 0/10 (0%) [0-28] |
| id_document | 10/10 (100%) | 10/10 (100%) [72-100] |
| letter | 10/10 (100%) | 10/10 (100%) [72-100] |
| policy | 10/10 (100%) | 10/10 (100%) [72-100] |
| receipt | 7/7 (100%) | 7/8 (88%) [53-98] |
| **overall** | **37/39 (95%)** | **37/48 (77%) [63-87]** |

CI replays the committed recordings and recomputes these counts; a mismatch
fails the build with "run pnpm eval:record".
