# Desk review: Bitwarden's local storage model

Status: reviewed 2026-07-29. Timeboxed desk review, issue #71 **direction 3
only** (adopt their ideas). Input to ADR-0011.

This is a reading of public documentation, not a code audit and not a
measurement. It exists so that "Bitwarden-style encrypted blobs" enters
ADR-0011 as a real option with real properties rather than as a strawman. The
integrate-versus-partner question (#71 directions 1 and 2) is explicitly out of
scope here and is a separate, later ADR.

## What they actually do

### Key derivation and the key hierarchy

Bitwarden derives everything from the master password through a four-step
chain, and the shape of that chain is the transferable idea:

1. **Master password + email as salt** through a KDF produces the 256-bit
   **master key**. Default KDF is PBKDF2-SHA256 at **600,000 iterations**;
   Argon2id is offered as an alternative (defaults 32 MiB memory, 6
   iterations, 4 threads, described as above current OWASP recommendations).
2. The master key is **stretched with HKDF to 512 bits**.
3. A separate, **randomly generated 512-bit symmetric key** is the key that
   actually encrypts vault data. It is encrypted with the stretched master key
   to produce the **protected symmetric key**, which is what gets stored.
4. Each vault item gets its **own random 64-byte cipher key**, itself
   encrypted with the user symmetric key.

Content encryption is AES-256-CBC with HMAC-SHA256 for integrity
(`AES256-CBC-HMAC-SHA256`); RSA-OAEP is used for sharing. The master key and
stretched master key are never stored or transmitted.

**The idea worth stealing:** the data-encrypting key is random and independent
of the password. Changing the password re-encrypts one small key, not the
whole store, and key rotation never means re-encrypting the corpus. This is
exactly the property Outtray wants if a user ever changes how they unlock.

### Unlock flow and key lifetime

- Unlocked: the user symmetric key is **held in memory only**, for as long as
  the client is unlocked.
- Locked: keys and vault data are "purged as aggressively as possible" from
  memory, including reloading the process after inactivity.
- Locked is not logged-out: the encrypted local blob stays on disk, so the
  client works offline and re-unlocking is local.

**The idea worth stealing:** lock is a first-class state distinct from
logged-out, and it is cheap because the ciphertext never leaves disk. An
Outtray equivalent would be "the index stays, the key goes".

### The narrow access surface

The Bitwarden CLI is the clearest expression of the pattern relevant to
ADR-0008. `bw unlock` returns a **session key**; every command that touches
vault data (`list`, `get`, `edit`) requires it via `BW_SESSION` or
`--session`. Commands that do not need decryption (`config`, `encode`,
`generate`, `status`) work without one. `bw lock` invalidates the session key.

**The idea worth stealing:** the boundary is drawn at *decryption*, not at
*the process*. Operations are split by whether they need plaintext, and only
that subset requires an unlock token. This maps cleanly onto Outtray: planning
actions over already-extracted metadata need far less than re-reading
document text.

### On-disk shape

The desktop client keeps a single encrypted `data.json` holding the vault
blob, complete enough to serve as an offline backup. Bitwarden's own docs do
not describe the local cache file in detail (the whitepaper covers the
client-server model), so the granularity of local encryption is not something
this review can state with confidence.

## What transfers to Outtray, and what does not

Transfers well:

- **Random data key wrapped by a key-encryption key.** Cheap to adopt, makes
  rotation and unlock-method changes cheap forever. Worth doing regardless of
  which storage option ADR-0011 picks.
- **Lock as a distinct state.** Ciphertext on disk, key in memory, purged on
  lock.
- **Access surface split by decryption need**, not by process boundary.
- **Per-item keys** are the mechanism behind their sharing model. For a
  single-user local app this is mostly cost without benefit, with one real
  exception noted in ADR-0011: it is what would let a single sensitive field
  be individually protected.

Does not transfer:

- **The blob-per-vault storage shape.** Bitwarden's data is a few thousand
  small items always loaded whole. Outtray's is a 21 MB embedding index that
  must be scanned per query and updated incrementally per document. Decrypting
  the whole store into memory on every operation is the wrong shape on an 8 GB
  machine, and it discards SQL entirely.
- **The password-derived root.** Bitwarden must derive from a password because
  it is zero-knowledge against its own server. Outtray has no server and can
  hold a random key in the macOS Keychain, which is both stronger and free at
  unlock time (0.7 ms versus 136 ms measured in the SQLCipher spike).
- **600,000-iteration KDF costs**, for the same reason: only relevant if we
  choose a passphrase unlock.

## Bottom line for ADR-0011

Bitwarden's *storage container* is not a good fit for a vector index. Its *key
management* is a good fit and is largely orthogonal to the container choice.
The productive reading is therefore not "SQLCipher versus Bitwarden-style
blobs" as an either/or: it is "take their key hierarchy and lock model, put it
on top of whichever container we choose."

## Sources

- [What encryption is used?](https://bitwarden.com/help/what-encryption-is-used/)
- [KDF algorithms](https://bitwarden.com/help/kdf-algorithms/)
- [Bitwarden security whitepaper](https://bitwarden.com/help/bitwarden-security-white-paper/)
- [Bitwarden CLI](https://bitwarden.com/help/cli/)
- [Data storage](https://bitwarden.com/help/data-storage/)
