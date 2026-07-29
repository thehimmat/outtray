# ADR-0011: One persistence layer for the index and the label store

Status: **proposed** 2026-07-29. Awaiting owner sign-off (issue #70).

Supersedes nothing. Resolves the encryption-mechanism question left open by
ADR-0007, and unblocks #43 (persist the vector index) and #67 (persist the
classifier label store). Evidence: `docs/evals/sqlcipher-spike.md` (#6) and
`docs/research/bitwarden-storage-model.md` (#71 direction 3).

## Context

Three open issues are one question. Outtray currently keeps nothing between
runs:

- **#43**: `outtray find` re-extracts and re-embeds the entire folder on every
  query. On the 8 GB Air that means a model swap and seconds per document to
  answer a question that should cost milliseconds.
- **#67**: the classifier's label store (seeds plus the user's future
  corrections) is rebuilt from seeds every run, so ADR-0009's core promise,
  "it gets better as you correct it", cannot survive a restart.
- **#6**: ADR-0007 committed to encryption at rest and named SQLCipher as the
  candidate, but explicitly deferred the mechanism until a spike proved the
  build path.

Deciding these separately would produce two stores, two encryption stories,
two backup units and two migrations into Phase 3. They should be one decision.

Two pieces of evidence now exist that did not when ADR-0007 was written.

**The spike (#6) settled the build path.** Encrypted SQLite works from plain
Node on this machine: install compiles from source in 39 s with no special
tooling, and open, key, write, read, rekey and wrong-key rejection all pass. A
full scan of a corpus 5x larger than expected costs 77 ms encrypted versus
14 ms plaintext, and a Keychain-held raw key makes unlock effectively free
(0.7 ms). It also found that the obvious configuration is the wrong one:
upstream compatibility requires `PRAGMA cipher = 'sqlcipher'` **and**
`PRAGMA legacy = 4`, without which the file cannot be read by any other
SQLCipher implementation and leaves the SQLite header struct in the clear.
With `legacy = 4`, files written from Node are read by the upstream Zetetic
`sqlcipher` CLI and vice versa, which is the evidence that Phase 3 can inherit
this database instead of migrating it.

**The Bitwarden review (#71 direction 3) separated two questions** that are
easy to conflate: what the container is, and how the key is managed. Their
container (one encrypted blob, always loaded whole) is a poor fit for a 21 MB
embedding index that must be scanned per query and updated per document. Their
key management is a good fit and is independent of the container choice.

## Decision (proposed)

### 1. One encrypted SQLite database, three tables

A single file at `~/Library/Application Support/outtray/outtray.db`, holding
documents (content hash, path, type, extraction JSON, reconciliation verdict),
chunks (text plus embedding BLOB), and classifier labels (embedding plus label
plus provenance: seed or user correction). One file is one key, one backup
unit, one thing to delete, and one thing for Phase 3 to open.

Encryption is SQLCipher via `better-sqlite3-multiple-ciphers`, configured
`cipher = 'sqlcipher'` then `legacy = 4`, in that order. The `legacy = 4`
setting is not optional and not cosmetic; the spike documents why, and the
store asserts the resulting configuration at open time so a future dependency
bump cannot silently change the on-disk format.

### 2. Key custody: a random key in the macOS Keychain

The database key is 32 random bytes generated at first run and stored in the
macOS Keychain, passed as a raw key so no KDF runs at unlock. It is never
derived from anything the user types, which is the transferable lesson from
Bitwarden: a random data key means changing how the user unlocks never means
re-encrypting the corpus.

v1 does not add a wrapped-key indirection (a key that encrypts the key). That
layer earns its complexity only when a user-supplied secret exists, and none
does yet. If a passphrase unlock or a non-macOS target ever arrives, the
migration is to wrap the existing key rather than to re-encrypt data, and the
spike measured full rekey at 506 ms on a 21 MB database as the fallback.

"Locked" as a distinct state (ciphertext on disk, key purged from memory) is
adopted as a Phase 3 UI concern; v1 is a CLI whose process exits.

### 3. Raw identifiers do not accumulate in structured columns

**Position on #71 direction 1: Outtray is not the durable home for the user's
identifiers, and its structured store should not become an index of them.**

The extraction contract (ADR-0004) already produces `id_document.id_number`,
`policy.policy_number` and `statement.account_number` as required strings. The
action layer does not need any of them: it needs "this passport expires
2027-03-01", not the passport number. Persisting them as structured columns
would build the single highest-value target in the product for no feature.

Concretely, at the persistence boundary:

- Identifier-class fields are stored **redacted** (last four characters plus
  length, enough to disambiguate two documents of the same type) together with
  a citation to the source document. Anything needing the full value reads the
  original document, which is on the user's disk already and which Outtray
  indexes in place and never copies (ADR-0007).
- Where a user genuinely wants a durable, retrievable identifier, the
  destination is their own vault, not our database. That is #71 direction 1,
  and this ADR takes no position on whether we integrate with it, only that
  the gap is not filled by quietly persisting the values ourselves.

**The honest limit of this position**, stated plainly because it would
otherwise read as stronger than it is: the chunk table stores document text
for retrieval, and that text contains the identifiers. Redaction narrows what
is *queryable and concentrated*, it does not make the store free of sensitive
data. That is precisely why the whole file is encrypted rather than only
selected columns. Redaction and encryption are doing different jobs here, and
neither substitutes for the other.

### 4. A `StorageProvider` interface, native code at the edge

Core keeps its provider pattern (`ModelProvider`, `EmbeddingProvider`): the
domain logic depends on a `StorageProvider` interface, with the SQLCipher
implementation as the adapter and an in-memory implementation for tests. Pure
logic stays unit-testable without a native module, CI keeps compiling one
native dependency at a known cost, and Phase 3 swaps the adapter without
touching planning, retrieval or classification.

## Options considered

1. **Encrypted SQLite (SQLCipher), one file, key in the Keychain
   (recommended).** Pros: ADR-0007's stated intent, now with a proven build
   path and measured costs (77 ms per query scan, unlock effectively free, 20 KB
   of size overhead on a 21 MB database); one file to back up and delete; SQL
   for the incremental updates #43 and #67 need; upstream-compatible on-disk
   format, so Phase 3 inherits the file rather than migrating it; a stolen
   laptop yields an unreadable file even without FileVault. Cons: a native
   dependency to build in CI and to package for Tauri later; encryption is
   roughly 2x to 5x slower than plaintext in relative terms; the `legacy = 4`
   trap is exactly the sort of thing that silently regresses on a dependency
   bump, so it needs an assertion and a test.
2. **Plain SQLite, relying on FileVault.** The same database with no
   encryption, and honest documentation saying "turn on FileVault, here is how
   to check". Pros: simplest possible thing, no native crypto, fastest, and on
   a Mac with FileVault on the practical protection against a stolen laptop is
   similar. Cons: the protection is conditional on a setting we do not control
   and cannot verify for the user; anything that copies the file out of a
   running system (backup, sync, another app, a curious process) copies
   plaintext; for a product whose pitch is privacy it is a weak answer to
   "what if someone gets the file"; and it makes encryption a later migration
   over real user data, which is the specific thing ADR-0007 set out to avoid.
   This remains the documented fallback, and the spike removed the reason to
   take it.
3. **Bitwarden-style encrypted blob files.** Store state as encrypted blobs
   with their key hierarchy, no SQL. Pros: no native dependency (Node's own
   crypto suffices); a well-understood, well-audited design to copy; naturally
   portable across platforms. Cons: the shape is wrong for this data. Their
   model loads and rewrites the whole vault; ours must scan 21 MB of
   embeddings per query and update single documents incrementally. It would
   mean either decrypting everything into memory on every operation, which is
   the wrong move on an 8 GB machine, or reimplementing indexed, incrementally
   updatable storage by hand. Their key management is worth adopting and is
   adopted above; their container is not.
4. **Plain SQLite plus field-level encryption.** Plaintext database, encrypt
   only the sensitive columns and BLOBs in application code. Pros: no native
   dependency; encrypts selectively; queryable metadata stays queryable. Cons:
   in practice nearly every column is sensitive (document paths and titles are
   themselves revealing), so this approaches whole-file encryption with more
   moving parts; it is hand-rolled cryptography at the application layer,
   which is the standard way to get this wrong; embeddings would have to be
   decrypted per row during a scan, likely slower than SQLCipher's page-level
   encryption rather than faster.
5. **JSON cache now, decide encryption in Phase 3.** Persist to plain JSON
   files keyed by content hash; revisit when the UI exists. Pros: could ship in
   an afternoon and would immediately fix the #43 complaint. Cons: it is a
   third storage mechanism that still has to be replaced, and replacing it
   means migrating real user data, which is the migration ADR-0007 explicitly
   exists to prevent; it also leaves extracted document text in plaintext on
   disk in the interim, which is the worst posture of any option here.

## Consequences

- #43 and #67 unblock together against one interface, and the classification
  scoreboard can finally measure the "gets better with corrections" claim
  across runs rather than within one.
- `packages/core` gains its first native dependency, at the edge and behind an
  interface. CI compiles it (about 40 s cold on this machine, cached
  thereafter); no model is involved, so hermeticity is unaffected.
- The on-disk format is upstream SQLCipher, so the Phase 3 Rust side can open
  the same file. The residual risk is that this has been proven against the
  upstream CLI rather than against an actual Tauri build; that check is
  tracked as a follow-up and should happen before Phase 3 commits to it.
- ADR-0007 moves from "encryption targeted, mechanism pending a spike" to
  decided, and its fallback stays documented as the answer if the native
  dependency ever becomes untenable.
- The redaction position creates a schema question this ADR does not settle:
  extraction still produces full identifier strings in memory before the
  store drops them. Whether extraction should stop asking for them at all is
  an ADR-0004 question, filed separately.
- Key loss means data loss, by design. The database is a derived cache whose
  originals are untouched on disk, so recovery is a re-scan, and the UI must
  say so plainly rather than implying the store is a backup.
