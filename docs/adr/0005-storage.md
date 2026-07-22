# ADR-0005: Storage

Status: accepted. Date: 2026-07-21.

## Context

Local-first promises one file, trivially backed up. The early draft proposed
SQLite + sqlite-vec, but a July 2026 health check found sqlite-vec in
maintenance mode (pre-v1 two years after launch, 155 open issues, author's
stated maintenance-mode goal) and, decisively, its stable releases are
brute-force scan only, so it offers no algorithmic advantage at our corpus
size. A personal document corpus is roughly 10^3 to 10^4 chunks at 384-768
dims: a few million FLOPs per query, well under 50 ms in plain TypeScript.

## Decision

- **SQLite** for all structured data, one local database file.
- **Embeddings stored as BLOBs; similarity ranked by an in-TypeScript
  brute-force cosine scan** (`packages/core/src/vector.ts`). No native vector
  extension, which also keeps Tauri packaging and signing simple.
- Embedding model must be tiny (100-600 MB class) per the ADR-0002 memory
  budget.
- Documented upgrade path: LanceDB (healthy, active TS SDK) if the corpus
  ever exceeds ~10^5 chunks. Adopt only if measured latency demands it.

## Consequences

- Zero native dependencies for retrieval; the scan is unit-tested pure code.
- Encryption of this file is a separate decision: ADR-0007.
