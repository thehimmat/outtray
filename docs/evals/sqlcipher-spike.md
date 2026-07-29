# SQLCipher spike: the encrypted-SQLite build path on the 8 GB Air

Status: run 2026-07-29. Issue #6. Feeds ADR-0011 (persistence layer) and
resolves the ADR-0007 open question ("a spike must prove the SQLCipher build
path before Phase 1 storage code lands").

**These are single-machine, single-session numbers from one spike run, not a
scored eval.** They exist to retire a build-path risk with measured data and to
give ADR-0011 real costs instead of guesses. Every number below is a local
dev-run on a machine that was not pristine.

## TL;DR

- **The build path works.** `better-sqlite3-multiple-ciphers@12.11.1` installs
  and runs from plain Node on this machine. Open, key, write, read, reopen,
  reject-wrong-key, reject-no-key, and rekey all pass. ADR-0007's documented
  fallback (plain SQLite plus a FileVault stance) is **not** needed.
- **Install friction is real but one-time and small**: no prebuilt binary
  matched this Node ABI, so it compiled from source in **39 s** using the
  already-installed Command Line Tools. No Xcode, no Homebrew SQLCipher, no
  manual build flags. 40 MB installed, a 2.1 MB native `.node` artifact.
- **The default cipher is not SQLCipher, and the default SQLCipher mode is not
  upstream-compatible.** Two traps, both cheap to avoid, both invisible until
  you test them (details below). The correct configuration is
  `PRAGMA cipher = 'sqlcipher'` **followed by `PRAGMA legacy = 4`**.
- **Interop with upstream SQLCipher is proven, not assumed.** With `legacy=4`,
  a database written by Node is read by the upstream Zetetic `sqlcipher` CLI
  4.17.0, and vice versa, for both passphrase and raw keys. This is the
  evidence that Phase 3 can inherit the Phase 1/2 database rather than migrate
  it.
- **Encryption costs are affordable at our corpus size.** At 5000 chunks (5x
  the expected personal corpus), a full embedding scan goes from **14 ms
  plaintext to 77 ms encrypted**. The relative overhead looks alarming
  (+438%); the absolute number is what matters, and 77 ms is far inside the
  ADR-0005 "well under 50 ms of compute, dominated by everything else" budget.
- **A Keychain-held raw key makes unlock free**: 0.7 ms to reopen, versus
  136 ms when a passphrase must go through the 256,000-iteration KDF. Both are
  acceptable; the raw key is strictly better and is what ADR-0007 already
  assumes.

## Environment

- 2022 MacBook Air, Apple Silicon, 8 GB unified memory (the ADR-0002 target).
- macOS 14.5, Node v23.11.0, npm 11.4.1, arm64.
- Driver: `better-sqlite3-multiple-ciphers@12.11.1`, bundling SQLite 3.53.2
  and the SQLite3MultipleCiphers encryption layer.
- Independent implementation for interop: Homebrew `sqlcipher` 4.17.0
  community (SQLite 3.53.3), installed for this spike.
- Machine was not pristine (other apps resident). Timings are wall-clock from
  one session; treat sub-20% differences as noise. The pass/fail results and
  the on-disk format findings are not noise-sensitive.

## Method

`docs/evals/spike/sqlcipher-spike.mjs`, run from a throwaway directory where
the driver is installed. The harness deliberately resolves its native
dependency from the **cwd**, so the spike never enters the workspace lockfile.

```bash
mkdir /tmp/sqlcipher-spike && cd /tmp/sqlcipher-spike
npm i better-sqlite3-multiple-ciphers
node /path/to/outtray/docs/evals/spike/sqlcipher-spike.mjs ./out
```

The schema mirrors the real consumers: a `documents` table (content hash, path,
type, extracted JSON) and a `chunks` table with 768-dimension float32
embeddings as BLOBs, which is what #43 and #67 will actually store. Workload is
5000 documents-plus-chunks, roughly 5x the expected personal corpus
(10^3-10^4 chunks per ADR-0005), giving a 21 MB database.

Two access patterns are timed:

- **seed**: bulk insert of 5000 rows in one transaction (the indexing path).
- **scan**: read every embedding BLOB and touch every float (the ADR-0005
  brute-force cosine path, the cost of one `outtray find` query once the index
  is persisted).

The battery runs three times over the same workload, against a plaintext
baseline that uses the same driver with no key, so the delta isolates
encryption rather than the library.

## Results

All checks pass under the recommended configuration
(`cipher = 'sqlcipher'`, `legacy = 4`):

| Check | Result |
| --- | --- |
| Encrypted db opens with a 32-byte raw key | pass |
| Write then read back while keyed (5000 chunks) | pass |
| Reopen with the same key | pass (0.7 ms) |
| On-disk header is not the plaintext SQLite magic | pass |
| Bytes 16-23 are not a readable SQLite header struct | pass |
| Wrong key cannot read the database | pass (`file is not a database`) |
| Unkeyed open cannot read the database | pass |
| Rekey rotates the key and data survives | pass (506 ms) |
| The old key stops working after rekey | pass |
| Passphrase-derived key works (KDF unlock path) | pass (136 ms) |
| Upstream `sqlcipher` CLI reads the Node-written file | pass |
| Node reads the upstream-CLI-written file | pass |

### Cost of encryption (5000 rows, 768 dims, 21 MB database)

| Mode | seed | scan | reopen (raw key) | unlock (passphrase) | rekey | size |
| --- | --- | --- | --- | --- | --- | --- |
| plaintext baseline | 90 ms | 14 ms | 0.3 ms | n/a | n/a | 21155840 B |
| chacha20 (driver default) | 148 ms | 38 ms | 0.4 ms | 23 ms | 219 ms | +0.0% |
| sqlcipher (default mode) | 210 ms | 88 ms | 0.7 ms | 134 ms | 462 ms | +0.1% |
| **sqlcipher, legacy=4 (recommended)** | **213 ms** | **77 ms** | **0.7 ms** | **136 ms** | **506 ms** | **+0.1%** |

Read the absolute numbers, not the percentages. A full scan of a corpus 5x
larger than expected costs 77 ms encrypted. Indexing 5000 documents costs
213 ms of database time, which is noise next to the seconds-per-document the
VLM extraction already spends (see `model-memory-spike.md`). Storage overhead
is 20 KB on a 21 MB database.

The three cipher modes differ by roughly 2x on scan and 6x on passphrase
unlock. Since the recommended mode is also the compatible one, that cost is not
really a choice, and it is affordable regardless.

## The two traps

Both were found by testing rather than by reading, and both would have been
expensive to discover in Phase 3.

### 1. The default cipher is chacha20, not SQLCipher

The package is named after SQLCipher but implements several cipher schemes.
Without an explicit `PRAGMA cipher = 'sqlcipher'`, a new database is encrypted
with **chacha20** at `kdf_iter = 64007`. It is a perfectly good cipher, and it
is measurably faster. It is simply not SQLCipher, so nothing else in the
SQLCipher ecosystem can open it, and `PRAGMA cipher_version` returns nothing,
which is a confusing way to learn this.

### 2. `PRAGMA cipher = 'sqlcipher'` alone is still not upstream-compatible

This is the finding that matters for Phase 3. With `cipher = 'sqlcipher'` and
otherwise-default settings, every visible parameter already matches upstream
SQLCipher 4:

```
kdf_iter = 256000    kdf_algorithm  = 2 (PBKDF2_HMAC_SHA512)
page_size = 4096     hmac_algorithm = 2 (HMAC_SHA512)
hmac_use = 1         plaintext_header_size = 0     legacy = 0
```

and yet the upstream `sqlcipher` 4.17.0 CLI rejects the file with
`file is not a database`, in **both** directions, for both passphrase and raw
keys. Setting `PRAGMA legacy = 4` (which the driver documents as "SQLCipher
version 4 defaults") fixes it completely, in both directions.

The on-disk difference is visible in the first 24 bytes. Bytes 0-15 are the
cipher salt in every mode, by design. Bytes 16-23 are where SQLite keeps page
size, write/read version and reserved-bytes count:

```
chacha20            9b276253e1838f7378e4846cd5c663ad  1000 0101 20 402020
sqlcipher (default) 6df856f11c04eb8676603c0cfff298d2  1000 0101 50 402020
sqlcipher legacy=4  531af7f36b60326d8a2b186e921f50c4  5045 355b e3a3 2cff
```

In the first two modes that header struct is **left in the clear**: page size
4096, write version 1, read version 1, reserved bytes (0x20 = 32 for chacha20,
0x50 = 80 for SQLCipher), and the standard payload fractions `40 20 20`. Under
`legacy = 4` those bytes are ciphertext, matching upstream, which encrypts the
whole first page after the salt.

The leak itself is minor: it reveals "this is a SQLite database with this page
size and this cipher's reserved-byte count", not user data. But it also means
the file is trivially fingerprintable as a SQLite database, and more
importantly it is the visible symptom of an incompatible wire format. `legacy
= 4` fixes both at once.

Note the driver's documentation recommends against `legacy` mode generally
("supported for compatibility reasons only"). That advice is aimed at people
who do not need to interoperate. We do, so we take the compatible format
deliberately, and this document is the reason why.

### Reproducing the interop check

The harness writes `interop.db` under `legacy = 4` with a fixed, published key
(no secret, synthetic rows only):

```bash
sqlcipher out/interop.db \
  "PRAGMA key = \"x'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'\"; \
   SELECT COUNT(*) FROM chunks;"
```

which prints `10`.

## What this does and does not prove

Proven on this machine:

- The native module builds and runs from plain Node without special tooling.
- Encrypted databases behave correctly, including key rotation.
- The wire format is upstream-SQLCipher-compatible under `legacy = 4`, so an
  independent implementation can read our file.

Not proven, and deliberately out of scope for this spike:

- **Rust-side reading in an actual Tauri build.** The interop evidence is
  against the upstream `sqlcipher` CLI, which is the same Zetetic
  implementation `rusqlite`'s `bundled-sqlcipher` feature compiles, but the
  Phase 3 build itself has not been attempted. This is the residual risk and
  is tracked separately.
- **Key custody.** Nothing here touches the macOS Keychain; the spike
  generates keys with `crypto.randomBytes`. Getting the key in and out of the
  Keychain (and what happens on backup, migration, or Keychain reset) is
  ADR-0011 territory and then implementation work.
- **Concurrency, WAL mode, corruption recovery, and backup behaviour** were
  not exercised.
- **Whether an encrypted store is the right shape at all** for the label store
  versus the vector index. That is the ADR-0011 question this evidence feeds.

## Artifacts

- `spike/sqlcipher-spike.mjs` - the harness. Standalone Node ESM; needs
  `better-sqlite3-multiple-ciphers` installed in a throwaway directory.
  Resolves its dependency from the cwd so it never enters the lockfile.
- `spike/result-sqlcipher.json` - raw output of the run reported here,
  including per-battery pragmas, header bytes, and timings.
