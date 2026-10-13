# ADR-0012: Incremental scan and a persisted retrieval index

Status: **accepted 2026-10-13 by Claude** under the project's autonomy rules
(`.claude/CLAUDE.md`, "Ownership, autonomy, and owner checkpoints"). It
refines how ADR-0005 and ADR-0011 are built and reverses neither. Issue #43.

## Context

`outtray find` and `outtray actions` re-run the vision model over every
document on every invocation. On the 8 GB Air that is several seconds per
page plus a model swap, every time, for documents that have not changed.
ADR-0011 gave us one encrypted store keyed by content hash; `scan` already
writes documents to it (#79). What is missing is (a) a rule for when a stored
extraction may be reused instead of re-extracting, and (b) a persisted chunk
index so `find` can search without re-deriving anything.

One constraint from ADR-0011 shapes everything below: **the store only ever
holds the redacted extraction.** The full identifier exists in memory between
the model and the write path, and nowhere else. Chunk text must be built from
the tokenized full extraction (amendment, section 2: a `[field]` placeholder,
no last four). So chunks cannot be rebuilt later from what is stored; they
have to be built at extraction time, while the full extraction is in memory.

## Decision

### 1. Two version keys on each document

Migration 2 adds two nullable columns to `documents`:

- `extractor_key`: the model tag plus both prompt versions
  (`qwen3-vl:2b|extract-v1|extract-typed-v1`). Changing the model or a prompt
  makes every stored extraction stale. The extraction schema only changes
  together with a prompt version, by convention.
- `index_key`: the embedding model plus the chunker and tokenizer versions
  (`nomic-embed-text|chunk-v1|tokenize-v1`). Null means "not indexed", which
  is also the state left behind if indexing fails part way.

### 2. When a stored document is reused instead of re-extracted

A scanned file is reused, with no model call, only when all of these hold:

1. A document with its content hash is stored, and its extraction is not
   null (a failed extraction is always retried).
2. Its `extractor_key` equals the current one.
3. Its `index_key` equals the current one (chunks can only be rebuilt from a
   fresh extraction, per the constraint above).
4. Identifier storage is off, or the document's type has no identifier
   field, or the vault already holds that document's identifier. This is the
   ADR-0011 amendment's requirement that switching the setting on must force
   re-extraction, or the vault never fills.

A reused item carries the stored (redacted) extraction and the stored
reconciliation verdict, and skips the classification and typed re-extraction
stages. Its stored row gets the new path and scan time; nothing else is
rewritten, and the vault is left alone.

### 3. The index is built on the scan write path

After extraction and classification, every freshly extracted document's
tokenized text is chunked and embedded in one batch (the embedder is already
loaded for classification, so this adds no model swap), and written with
`putChunks`. The document row is written with `index_key` null first and set
only after its chunks are written, so a failure part way leaves a document
that is re-extracted next time rather than one that claims an index it does
not have.

### 4. `find` searches the store

A query scans the folder incrementally (unchanged documents cost one hash
each), then ranks stored chunks of the documents found in that folder whose
`index_key` is current. Repeat queries load no vision model; they embed the
query only. When the store cannot be opened (no Keychain, not macOS), `find`
falls back to today's in-memory path and says so.

### 5. Redaction is idempotent

Reused extractions are already redacted, and every output surface calls
`redactExtraction` again. Re-redacting `[id_number ending 4567, 9 chars]`
would treat it as a 24-character identifier and print a nonsense last four.
`redactExtraction` and `tokenizeExtraction` therefore recognize the redacted
form and leave it (redact) or turn it into the placeholder (tokenize).

## Options considered

1. **Persist chunks at scan time, keyed by content hash plus two version
   keys (recommended).** Pros: repeat `find` and `actions` skip the vision
   model entirely; respects the redacted-only store; any model or prompt
   change invalidates exactly the right rows; a half-failed write degrades to
   "re-extract next time", never to a wrong answer. Cons: changing only the
   embedding model also forces re-extraction, because chunk text is not
   rebuildable from the redacted store. That is cheaper to fix later (re-embed
   stored chunk text, which is already tokenized) than to design now; filed
   as a follow-up.
2. **Persist the full extraction in a separate encrypted column and derive
   chunks lazily.** Pros: chunks can be rebuilt any time. Cons: puts every
   identifier back into the documents table in full, which is exactly what
   the ADR-0011 amendment removed. Rejected.
3. **A JSON cache file beside the folder, as #43 first suggested.** Pros:
   trivial. Cons: unencrypted derived text on disk next to the user's
   documents, the opposite of ADR-0007 and ADR-0011. Rejected.
4. **Reuse by path and modification time instead of content hash.** Pros:
   no file read for unchanged files. Cons: a moved file looks new, an edited
   file with a preserved mtime looks unchanged, and the store is already
   keyed by content. Hashing a few MB per page is milliseconds next to a
   multi-second extraction. Rejected.
5. **Reuse on content hash alone, without version keys.** Pros: simplest.
   Cons: a model upgrade would silently keep serving the old model's
   extractions, and the scoreboard would stop describing what users get.
   Rejected.

## Consequences

- `scan`, `actions` and `find` become incremental. The first run costs what
  it does today; later runs only extract new or changed files.
- `persistScan` grows a chunks input and must treat reused items differently
  (no re-redaction, no vault writes). Tests cover both.
- The classifier's verdicts are reused with the extraction. When #67 lets the
  label store change, a classifier version belongs in the reuse rule too.
- Embedding-model changes force re-extraction until the re-embed follow-up
  lands.
