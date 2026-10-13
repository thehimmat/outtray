---
title: The action eval found a privacy leak on its first run
status: draft
phase: 3
audience: engineers building LLM pipelines that handle personal data
---

# The action eval found a privacy leak on its first run

*Draft. Owner publishes.*

Outtray reads a folder of personal documents on a laptop and proposes what to
do about them: pay this bill, this passport is about to expire, shred this
receipt. The proposals are its whole point, so they get their own eval. The
first time that eval ran, it found a bug that had nothing to do with quality:
a policy number was leaking into the action queue in full.

## Scoring a queue, not a field

Extraction evals are well understood: compare each extracted field against a
label. An action queue is different. It is the product of extraction,
classification and a deterministic planner, and what the user sees is a list
of proposals. So the eval scores the list.

Each fixture gets its expected actions written from its ground truth, never
from what the model produced: a bill due in February expects a "pay" to-do
dated that day and "shred once paid" retention advice; an expired licence
expects an "expired" flag. The planner runs on the recorded extraction at a
fixed as-of date, so the eval never reads the clock, and planned items are
matched one to one on kind, rule, date and advice. To-do titles are the
model's own words, so a title only has to contain a few required words.

It needs no model at run time. It replays the same recorded extractions the
[record/replay CI gate](01-record-replay-ci-evals.md) already uses, so it runs
on every pull request and fails the build when the numbers move.

## The baseline, and the triage table

Precision 10/24, recall 10/13. The number matters less than the table under
it, which lists, per fixture, what was expected and not proposed and what was
proposed and not expected. One row read:

> policy-001: to-do "Comprehensive auto, $500 deductible"; to-do "POL-804220"

The small vision model had copied fields into `action_items`, including the
policy number, and had put it in the item's *due date* field.

## Why that was a leak

Outtray treats ID numbers carefully. They are tokenized out of everything it
indexes and redacted to the last four in everything it shows. The redaction
already covered free text, including each action item's text. It did not
cover the action item's due date, because a due date is a date. Nobody writes
a test for an identifier in a date field, because nobody expects one there.

The model does not share that expectation. It put a policy number where a
date belonged, the planner passed it through, and the full number reached the
queue. The fix was a few lines: scrub every string an action item carries.
Finding it took an eval that looked at the output as a whole rather than one
field at a time.

## The fixes, measured

Every fix since has shipped with its delta on the same scoreboard:

| Change | Precision | Recall |
| --- | --- | --- |
| Baseline | 10/24 | 10/13 |
| Read dates the way the eval scores them ("January 6, 2025") | 11/25 | 11/13 |
| Fold an action that restates an expiry into the expiry item | 11/22 | 11/13 |

The rest of the gap is the model inventing to-dos from fields, which is a
prompt change and needs a re-record on the laptop. It is filed, with the
scoreboard row that will show whether the change worked.

## What to take from it

- **Evaluate what the user sees.** Field-level evals would never have caught
  this: the policy number was "correctly" extracted, just copied somewhere
  else as well.
- **Let the model surprise your privacy rules.** Redaction keyed on where
  values are supposed to live trusts the model to put them there. Redact
  every string a structure can carry.
- **Keep the triage table.** The aggregate said "precision is low". The table
  said exactly why, one fixture at a time.

Caveats, honestly: ten synthetic fixtures, wide intervals, and a planner that
ran with no classifier verdict because embeddings are not yet recorded for
replay. The point is not the number; it is that the number now exists, gates
every change, and found a real bug on day one.
