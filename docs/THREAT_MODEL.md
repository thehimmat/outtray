# Threat model

Last reviewed: 2026-07-21. Reviewed whenever an ADR touching data flow
changes.

## Assets

- Original documents (passports, IDs, contracts, bills, statements) in
  user-chosen folders. The app indexes them in place and never copies them
  (ADR-0007).
- Derived data: OCR text, extracted fields, embeddings, thumbnails, all in
  one SQLite database under `~/Library/Application Support/`.
- No credentials or API keys exist in the local-only phases. A BYO cloud key
  (Phase 5, opt-in) will live in the macOS Keychain.

## Adversaries in scope

| Adversary | Vector | Mitigation |
| --- | --- | --- |
| Stolen or accessed laptop | Reads the extraction DB, a single-file PII jackpot | Encryption at rest (SQLCipher target, Keychain-held key) or a documented FileVault stance; DB outside cloud-sync scope (ADR-0007) |
| Malicious document | Prompt injection: attacker-authored text steering the agent that summarizes or flags it | Delimited data blocks, verbatim-evidence UI, no destructive tools, typed boundaries (ADR-0008) |
| Local process abusing exposed services | Ollama's unauthenticated localhost API sees every document | Loopback-only preflight; Ollama pinned and listed as trusted-but-audited; ModelProvider seam allows moving in-process (ADR-0002) |
| Compromised dependency | Supply-chain code exfiltrating documents | Minimal dependency count (zero runtime deps in core today), automated dependency updates, lockfile in CI |

## Out of scope (disclosed, not defended)

- Targeted nation-state attackers and a compromised OS/kernel.
- Time Machine and other user-initiated backups retain whatever they cover,
  including the DB; disclosed in docs rather than fought.
- Folders the user already syncs to iCloud or other clouds: the local-only
  guarantee covers what this app does, not where files already live. The app
  detects this case and says so once, honestly.

## Side channels handled

- iCloud Desktop & Documents sync: DB lives outside synced scope; synced
  source folders trigger the honest notice.
- Spotlight: derived-text caches are excluded from indexing.
- Crash logs and telemetry: there is no telemetry; crash reporting, if ever
  added, must be opt-in and document-content-free.

The complete list of network touchpoints lives in the README's "what leaves
the machine" table.
