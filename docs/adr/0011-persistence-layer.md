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

### 3. Raw identifiers are stored deliberately, behind a narrow reveal path

**Position on #71 direction 1: Outtray does store the user's extracted
identifiers, because "what is my passport number" is a real thing to want from
a document assistant. It stores them in one known place with a deliberately
narrow read path, rather than either scattering them or pretending not to have
them.**

The extraction contract (ADR-0004) produces `id_document.id_number`,
`policy.policy_number` and `statement.account_number` as required strings. Two
facts shape what to do with them.

First, the action layer does not need them. It needs "this passport expires
2027-03-01", not the number. So nothing in the queue, the CLI output, logs or
exports has any reason to carry a full identifier.

Second, and decisively: **the values are on disk either way.** The chunk table
stores document text so retrieval works, and that text contains the identifier
exactly as printed on the page. A rule that merely refused to write them into
a labelled column would not keep them off disk. It would only ensure they live
in an unlabelled text blob that receives no special handling, while also
denying the user a feature they want. That is the worst of both.

Concretely, at the persistence boundary:

- Full identifier values are stored in **their own table**, one row per
  document and field, with a citation to the source document. One known,
  auditable location, not an emergent property of text storage.
- **Nothing renders them by default.** The action queue, `outtray scan` and
  `outtray actions` output, any log line, and any export show the redacted
  form only: last four characters plus length, which is enough to tell two
  documents of the same type apart.
- **Reading a full value is an explicit, per-item act.** On the CLI that is a
  distinct command naming one document and one field; in the Phase 3 UI it is
  a per-item reveal, and it should sit behind Touch ID or a re-unlock. This is
  the Bitwarden lesson from the desk review applied directly: the boundary is
  drawn at *decryption*, not at the process. Operations that do not need
  plaintext never receive it.
- Handing an identifier to the user's own vault (#71 direction 1) reads
  through this same path. This table is what such an integration would hand
  over, so the position here does not prejudge that decision either way.

**The honest limits**, stated plainly because this is the part of the ADR most
likely to be read as stronger than it is:

- The reveal path narrows *casual and incidental* exposure: shoulder-surfing a
  terminal, a log file, a screenshot of the action queue, an export shared with
  someone. It does not defend against something running as the user on an
  unlocked machine, because such code can call the reveal path itself.
- Whole-file encryption, not the reveal path, is what protects a copied or
  stolen database file. The two mechanisms do different jobs and neither
  substitutes for the other.
- The chunk table still contains identifiers as free text. The dedicated table
  makes them *deliberate and revocable* (a purge can find and remove them);
  it does not make the rest of the store free of sensitive data.

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

### Options considered for identifiers specifically

This sub-decision is separable from the container choice, so it gets its own
comparison.

1. **Store full values in a dedicated table, redacted everywhere by default,
   explicit per-item reveal (recommended).** Pros: the user can actually
   retrieve their passport number, which is a reasonable thing to want from a
   document assistant; the values sit in one auditable place a purge can find;
   nothing incidental (queue, logs, exports, screenshots) carries them. Cons:
   more moving parts than either extreme; the reveal path is a surface that
   must be got right; it does not stop code running as the user.
2. **Redact at the persistence boundary, never store full values.** Pros:
   sounds strongest, and is the smallest structured target. Cons: mostly
   theatre, because chunk text on disk already contains the identifiers, so it
   moves them from a labelled column to an unlabelled blob rather than
   removing them; and it denies a real feature to buy that. Rejected on the
   owner's product call and on the inconsistency above.
3. **Store full values as ordinary columns, no special handling.** Pros:
   simplest, and the encryption arguably covers it. Cons: identifiers then
   leak into list views, CLI output, logs and exports by default, which is
   where casual exposure actually happens; it also makes any future export or
   sharing feature a hazard by default rather than by mistake.

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
- The identifier position settles the ADR-0004 question it might otherwise
  have raised: extraction keeps asking for full identifiers, because the
  product now has a use for them. What it adds instead is a display rule that
  every future output surface must honour, so redaction belongs in core next
  to the store rather than in each command.
- The reveal path is new user-facing surface with real failure modes: it must
  not be reachable from the action queue by accident, must not be logged, and
  needs its own tests. It also needs a decision in Phase 3 about whether Touch
  ID gates it, which is UI work this ADR does not settle.
- Key loss means data loss, by design, with one caveat this position adds. The
  database is otherwise a derived cache whose originals are untouched on disk,
  so recovery is a re-scan. The identifier table is derived too, so the same
  holds, but the UI must not let users treat it as a vault backup. If they
  want durable custody, that is #71 direction 1 and their own vault.
