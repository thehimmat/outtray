# Threat model

Last reviewed: 2026-07-31 (ADR-0011, identifier storage). Reviewed whenever an
ADR touching data flow changes.

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
| Compromised app page (desktop shell) | Script in the webview, for example injected through rendered extraction text, asks the shell to read files the user never chose | The shell reads only folders picked in its own native picker and the regular files directly in them, compared after resolving symlinks and `..` (`folder_scope.rs`, #123); the page holds no dialog or file-system permission and never receives the database key; CSP limits the page to IPC and local Ollama |

## Assessment: storing extracted identifiers (ADR-0011)

Added 2026-07-31 for the ADR-0011 decision to let users keep full identifier
values (passport, licence, policy and account numbers) in the local store. The
question asked was whether one central copy is meaningfully safer than the same
value sitting in several derived places, and whether storing it at all is a
risk worth taking.

The design assessed: one canonical encrypted row per identifier, tokenized out
of derived chunk text, redacted to last-four in every default output, full
value readable only by an explicit per-item act, and the whole feature off
unless the user turns it on.

| Scenario | Duplicated copies | One canonical copy | Verdict |
| --- | --- | --- | --- |
| Database file copied off the machine, attacker lacks the key | Unreadable | Unreadable | No difference. Encryption is what defends here |
| Database file copied, attacker has the key (Keychain also compromised) | All values exposed | All values exposed | No difference. One place versus three does not help an adversary already inside |
| Retrieval output printed to a terminal or piped to a file | Prints the number in chunk text | Prints a token | Material improvement, and the reason tokenization is not optional |
| Log file, crash artifact, or shell history | May capture the number | Captures last-four or a token | Material improvement |
| Screenshot or screen-share of the action queue | Shows the number | Shows last-four | Material improvement |
| Export or backup of derived data shared with someone | Carries the number | Carries a token | Material improvement |
| User asks Outtray to forget an identifier | Cannot be honestly promised: copies are spread through free text | One row to delete, references dangle safely | Material improvement; revocability only exists with one copy |
| Malware running as the user on an unlocked machine | Reads everything | Reads everything, including via the reveal path | No difference. Out of scope, as elsewhere in this document |
| Value never stored at all (feature off) | n/a | Only last-four is ever computed | Strictly safest, at the cost of the feature |

Conclusions:

1. **Centralizing does not improve the cryptographic threat model.** Against
   file theft it changes nothing, because whole-file encryption already covers
   that and covers it equally either way.
2. **Centralizing substantially improves the incidental-exposure and
   revocability picture**, which is where realistic harm to a single-user local
   app actually comes from: output, logs, exports, screenshots, and the
   inability to honestly delete something.
3. **Tokenization is best-effort.** It depends on locating the extracted value
   inside derived text, and normalization or OCR variance can defeat the match.
   It reduces copies; it must never be documented as guaranteeing one copy, and
   failures to tokenize should be reported rather than swallowed. Since #97 a
   run one edit away from the value, or of similar length ending in its last
   four, is also redacted, so a model that drops or swaps a digit no longer
   leaks the rest; a rewrite beyond that still survives.
4. **The residual risk is the user's to accept**, which is why the feature is
   off by default and disclosed in plain terms. Keeping a passport number in a
   local encrypted store is the same class of decision as keeping one in a
   password manager: reasonable, widely made, and not ours to make silently.
5. **Scope limit:** this covers the three extracted identifier fields only
   (`id_number`, `policy_number`, `account_number`).
   Names, addresses and dates of birth remain in derived text. The chunk table
   is not PII-free and must not be described as such.

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

## What the desktop app's page may read

The app's page (the webview) renders text the model extracted from
documents, so it is treated as the least trusted part of the app. It reaches
the store only through the Rust bridge, and the bridge refuses
`getIdentifier`: the page can write and purge remembered ID numbers but never
read one. Revealing a number is a Rust command that shows it in a native
dialog (ADR-0013 amendment 1); the page learns only whether one was shown.
Turning on remembering ID numbers also asks in a native dialog, so the page
cannot opt the person in by itself.

## Who may read the database key

The key is a legacy Keychain item, and macOS trusts only the program that
created it. On a first run from the desktop app, the CLI (which reads the key
through `/usr/bin/security`) shows a password dialog on every command. By
the same rule, a key first created by the CLI should make the app the one
that asks (only the first case was observed, on the Air, #127). This is
accepted for now (#134): a second program asking for the secret is the
Keychain doing its job.

"Always Allow" on that dialog is ruled out, as is any access list that names
`/usr/bin/security`: trusting that tool trusts every process that calls it,
so any code running as the user could read the key silently. The lasting fix
is one trusted reader (a signed broker) or a data-protection Keychain item
shared through an access group. Both need a signing identity (#12) and an
ADR-0011/0013 amendment.

The complete list of network touchpoints lives in the README's "what leaves
the machine" table.
