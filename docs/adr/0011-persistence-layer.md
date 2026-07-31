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

### 3. Identifiers live in exactly one place, by the user's choice

**Position on #71 direction 1: Outtray can be the place a user retrieves their
passport number from, because that is a reasonable thing to want from a
document assistant. If it is, the value exists in exactly one row of one
encrypted table, is tokenized out of every derived copy, is redacted in every
default output, and is only there because the user said yes.**

The extraction contract (ADR-0004) produces `id_document.id_number`,
`policy.policy_number` and `statement.account_number` as required strings.
Three facts shape what to do with them.

First, the action layer does not need them. It needs "this passport expires
2027-03-01", not the number. Nothing in the queue, CLI output, logs or exports
has any reason to carry a full identifier.

Second, **the values reach the derived store either way**. The chunk table
holds document text so retrieval works, and that text contains the identifier
as printed on the page. Refusing to write it into a labelled column never kept
it off disk; it only moved it somewhere that receives no special handling.

Third, and this is what settles the design: **a second copy in chunk text
defeats a reveal gate entirely.** If `outtray find "passport"` returns a chunk
that prints the number, then gating a separate `reveal` command accomplishes
nothing. Single-copy storage is not a nice-to-have alongside the gate. It is
the precondition for the gate meaning anything.

Concretely, at the persistence boundary:

- **One canonical row.** Full identifier values live in their own table, keyed
  by normalized value, with references from each document that mentions them.
  If a passport number appears on the passport, an insurance form and a bank
  letter, it is stored once and referenced three times, not stored three
  times.
- **Tokenized out of derived text.** Before chunk text is written, known
  identifier values are replaced by an opaque reference to that row. Retrieval
  and embeddings operate on tokenized text. This costs nothing in search
  quality: ranking is semantic cosine over embeddings (ADR-0005), and a raw
  digit string contributes approximately nothing to a semantic match.
- **Never in originals.** The user's document files are not modified, ever.
  Tokenization applies exclusively to text Outtray derives and stores.
  Originals stay byte-identical and remain the source of truth, per ADR-0007
  and ADR-0008.
- **Redacted in every default output.** The queue, `outtray scan`,
  `outtray actions`, logs and exports show last four characters plus length,
  enough to tell two documents of the same type apart. This is a rule enforced
  in core next to the store, not a habit each command has to remember.
- **Reading a full value is an explicit, per-item act.** On the CLI, a
  distinct command naming one document and one field. In the Phase 3 UI, a
  per-item reveal that should sit behind Touch ID or a re-unlock. This is the
  Bitwarden lesson applied directly: the boundary is drawn at *decryption*,
  not at the process.
- **The user decides whether any of this happens.** Identifier storage is a
  disclosed choice, **off by default**. Off means last-four is all that is
  ever computed or stored, and tokenization simply drops the value instead of
  vaulting it. On means the single encrypted row plus the reveal path.
  Switching from on to off purges the table, which is possible precisely
  because there is one place to purge. The choice is presented in the user's
  terms ("Outtray can remember your ID numbers so you can look them up here,
  or it can forget them and only show the last four"), which is the same
  decision a user makes when they choose to put a passport into a password
  manager.
- Handing an identifier to the user's own vault (#71 direction 1) would read
  through this same path, so this position does not prejudge that decision.

**The honest limits**, stated plainly because this is the part of the ADR most
likely to be read as stronger than it is:

- **Tokenization is best-effort, not a guarantee.** Removing a value from
  derived text requires finding it there. If the model normalizes what it read
  (strips spaces, corrects an OCR character, reformats `AB 123456` to
  `AB123456`), a literal match misses and the value stays in the text.
  Matching can be made good (normalize both sides, match variants, verify
  post-write) and it cannot be made certain. Documentation must therefore say
  "reduces copies", never "guarantees one copy", and the implementation should
  report when it could not find a value it expected to tokenize.
- **This covers four extracted fields, not personal data in general.** Names,
  addresses, dates of birth and account holders remain in chunk text. The
  chunk table does not become safe to leak; the four highest-value fields
  become non-duplicated. Whole-file encryption remains what protects the store.
- **Both the row and the chunks live in the same encrypted file.** Against an
  adversary holding the decrypted database, one copy versus three changes
  little. The gain is in every other scenario: terminal output, log files,
  exports, screenshots, and a purge that can actually complete.
- **The reveal path does not stop code running as the user** on an unlocked
  machine, since such code can call the reveal path itself.

A per-scenario assessment of what this does and does not buy is in
`docs/THREAT_MODEL.md`.

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

1. **One canonical encrypted row, tokenized out of derived text, redacted in
   all output, explicit reveal, user-chosen (recommended).** Pros: the user can
   retrieve their passport number; the value exists once, so a purge is
   complete and a reveal gate is meaningful; nothing incidental (queue, logs,
   exports, screenshots) carries it; the user makes the storage decision
   knowingly, as they would with a password manager. Cons: the most moving
   parts of any option; tokenization is best-effort and its failure mode is
   silent unless explicitly reported; the reveal path is new surface that must
   be got right; none of it stops code running as the user.
2. **Store full values in a dedicated table, but leave derived text alone.**
   Pros: simpler; still gets the values out of the action queue and logs.
   Cons: the reveal gate is decorative, because a retrieval query returns a
   chunk that prints the number anyway; a purge cannot honestly claim to have
   removed the value. Rejected once the interaction between the two tables was
   noticed.
3. **Never store full values; redact at the persistence boundary.** Pros:
   sounds strongest, smallest structured target. Cons: mostly theatre, because
   chunk text already contains the identifiers, so it relocates them from a
   labelled column to an unlabelled blob rather than removing them; and it
   denies a real feature to buy that. Available to any user who wants it, as
   the off setting in option 1.
4. **Store full values as ordinary columns, no special handling.** Pros:
   simplest; the encryption arguably covers it. Cons: identifiers leak into
   list views, CLI output, logs and exports by default, which is where casual
   exposure actually happens; it makes any future export or sharing feature a
   hazard by default rather than by mistake.
5. **Redact the user's original document files.** Rejected outright, recorded
   because it is the intuitive reading of "redact everywhere". It destroys the
   user's source of truth on the strength of a 2B model's extraction, is
   irreversible, and contradicts ADR-0007 (index in place, never modify
   originals) and ADR-0008 (propose, do not act). If a user wants a redacted
   passport scan, that is their deliberate act on a copy, and at most something
   Outtray could one day propose.

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
- **Tokenization sits on the write path of the chunk table**, which makes it
  load-bearing for retrieval correctness as well as privacy. It needs its own
  tests (values in several formats, values appearing more than once in a
  document, values that fail to match), and a failure to tokenize an expected
  value must surface rather than pass silently. It also means the tokenizer
  runs before embedding, so a change to it invalidates stored embeddings.
- **The feature is off by default**, so the default install stores no full
  identifiers at all, and everything above describes what happens when a user
  opts in. The first-run disclosure is UX work with a real honesty
  requirement: it has to state the best-effort limit without becoming a wall
  of caveats nobody reads.
- The threat-model assessment behind this (`docs/THREAT_MODEL.md`) concluded
  that centralizing identifiers does **not** improve the file-theft picture,
  which encryption already covers, and does substantially improve incidental
  exposure and revocability. Anyone tempted to sell this as a security feature
  should read that table first.
- The reveal path is new user-facing surface with real failure modes: it must
  not be reachable from the action queue by accident, must not be logged, and
  needs its own tests. It also needs a decision in Phase 3 about whether Touch
  ID gates it, which is UI work this ADR does not settle.
- Key loss means data loss, by design, with one caveat this position adds. The
  database is otherwise a derived cache whose originals are untouched on disk,
  so recovery is a re-scan. The identifier table is derived too, so the same
  holds, but the UI must not let users treat it as a vault backup. If they
  want durable custody, that is #71 direction 1 and their own vault.
