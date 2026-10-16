# Action scoreboard

Quality of the proposed action queue (ADR-0010), end to end from a recorded
extraction: each fixture's committed `qwen3-vl:2b` extraction is planned by
`planActions` as of 2026-07-22 and matched one to one against actions
authored from the fixture's ground truth (`packages/evals/fixtures/expected-actions.json`).
A match needs the same kind, rule, date and retention advice, and a title
containing the required words. Recall shows a 95% Wilson interval.
Regenerate with `pnpm eval:actions`; CI replays it and fails on drift.

Generated at commit `49b3a4e83c46` over 10 synthetic fixtures.

| Action kind | Precision | Recall (95% CI) |
| --- | --- | --- |
| attention_flag | 3/5 (60%) | 3/3 (100%) [44-100] |
| todo | 1/3 (33%) | 1/1 (100%) [21-100] |
| expiry_alert | 1/1 (100%) | 1/1 (100%) [21-100] |
| retention_advice | 6/8 (75%) | 6/8 (75%) [41-93] |
| **overall** | **11/17 (65%)** | **11/13 (85%) [58-96]** |

## Where it misses

| Fixture | Expected, not proposed | Proposed, not expected |
| --- | --- | --- |
| bill-001 | retention_advice shred | retention_advice keep |
| receipt-001 | - | attention_flag flag-past-due 2025-08-23 |
| letter-001 | - | todo todo-extracted |
| bill-002 | retention_advice shred | retention_advice keep |
| receipt-002 | - | attention_flag flag-past-due 2025-07-04 |
| letter-002 | - | todo todo-extracted |

## Caveats

- **VLM only.** Reconciliation runs with no classifier verdict because
  embeddings are not recorded yet (#52), so a type the extractor gets wrong
  costs its actions here even where the live two-stage pipeline corrects it
  (the classification scoreboard measures that stage on its own).
- **N is small.** Ten synthetic fixtures; intervals are wide and one fixture
  moves a row by double digits.
- **Expectations are authored, not observed.** To-dos are expected only where
  a document asks for something with a date. A model-proposed to-do with no
  counterpart counts against precision even when a person might find it
  useful; that is deliberate, since the queue's value is in not crying wolf.
