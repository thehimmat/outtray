# Fixture privacy policy

Labeled document fixtures are the test suite of this project (ADR-0006). They
are also exactly the kind of data this product exists to protect, so:

1. **Real personal documents are never committed.** Not redacted, not
   "mostly redacted". Real documents may serve as template donors for the
   synthetic generator only.
2. **Committed fixtures are synthetic**, produced by the fixture generator
   (lands in Phase 1) which emits ground-truth labels alongside each render.
3. **Every committed fixture must appear in the fixture manifest** with its
   provenance (`synthetic`) and SHA-256 checksum. CI fails on any fixture file
   missing from the manifest.
4. A small set of real documents may live in `fixtures/real/` on the dev
   machine only, to measure the synthetic-to-real gap. That directory is
   gitignored at the repo root; only aggregate numbers from it ever reach the
   committed scoreboard.

See `docs/evals/METHODOLOGY.md` for the full eval design.
