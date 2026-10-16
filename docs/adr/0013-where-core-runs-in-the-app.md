# ADR-0013: Where core runs inside the desktop app

Status: **accepted 2026-10-13** on owner sign-off (issue #117, PR #118
merged by the owner): option 2. Written by Claude. It refines ADR-0001 and
reverses nothing; it went to the owner because it is hard to reverse once
Phase 3 builds on it.

## Context

ADR-0001 fixed the stack: Tauri v2 with a React UI, all domain logic in
TypeScript in `packages/core` (which never imports Tauri), and Rust only for
the shell and OS integration. It did not fix where `core` executes once there
is an app, because nothing needed it until Phase 3.

`core` today assumes Node: it reads files with `node:fs`, opens the store
through a native module (`better-sqlite3-multiple-ciphers`), reaches the
Keychain by spawning `security`, and calls Ollama over loopback HTTP. A Tauri
webview has none of the Node APIs and cannot load a native Node module.

Two facts from this session change the options. #114 proved that `rusqlite`
with bundled SQLCipher, the build a Tauri app links, reads and writes the
exact store the CLI writes. And ADR-0011 already shaped the persistence seam
for this moment: `StorageProvider` is async throughout "to survive a Phase 3
implementation on the far side of Tauri IPC".

## Options considered

1. **A Node sidecar.** Ship a Node binary (Node's single-executable
   application support) inside the app bundle. Tauri starts it, and the UI
   talks to it over a small JSON-RPC channel through the Rust shell. `core`
   runs unchanged.
   - Pros: no core changes at all; the CLI and the app run literally the same
     code, so every eval and test covers the app; fastest path to a working
     shell.
   - Cons: a second resident process (a bare Node is about 45 MB RSS before
     any code loads) on an 8 GB machine where the model already takes about
     4 GB; a 60 to 90 MB binary in the bundle; the native SQLCipher module
     has to be packaged and signed inside the sidecar; two processes to keep
     alive, restart and shut down; an IPC protocol to version.
2. **Core in the webview, with Rust adapters (recommended).** `core` runs in
   the webview as ordinary TypeScript. Its OS-touching edges are already
   interfaces, so the app supplies Rust-backed implementations: a
   `StorageProvider` over Tauri commands into `rusqlite` (proven by #114), a
   key provider using the native Security framework (which also fixes #82
   properly), file reading through Tauri's file APIs, and Ollama over loopback
   `fetch`, which the webview can already do.
   - Pros: one process; nothing to bundle beyond what Tauri already
     ships; the Rust side is small and is mostly storage; Keychain access
     becomes native instead of shelling out; the seams ADR-0011 and ADR-0003
     built are used exactly as intended.
   - Cons: the store gets a second implementation (SQL in Rust), so the
     schema and migrations exist twice. That is mitigated by running the
     existing `StorageProvider` contract suite against the Rust adapter
     through the IPC boundary, the same way it already holds `MemoryStorage`
     and `SqlcipherStorage` to one contract. A few core modules that reach for
     `node:fs` or `node:crypto` directly (scan's file reading, content
     hashing) need an injected file reader and Web Crypto.
3. **Port core to Rust.**
   - Pros: one language at runtime, smallest footprint.
   - Cons: rewrites everything the evals measure, abandons the owner's primary
     language (ADR-0001's reason for TypeScript), and throws away the
     record/replay harness's coverage. Rejected.
4. **Run core in Tauri's Node-compatible plugins or a JS runtime embedded in
   Rust.**
   - Pros: no separate binary.
   - Cons: immature, and native modules still do not load, so it ends up as
     option 2 with extra machinery. Rejected.

## Decision

Option 2. `core` runs in the webview; the app package provides Rust-backed
adapters for storage, the key, and files; the CLI keeps its Node adapters.
The Rust storage adapter must pass the shared `StorageProvider` contract
suite before any UI depends on it.

## Consequences

- `packages/core` gains no Tauri import (ADR-0001 holds): adapters live in
  `packages/app`.
- Two places that use `node:` APIs inside core move behind injected
  interfaces (file reading for scans, hashing via Web Crypto), so core runs
  in both hosts. This is the bulk of the core-side work and is testable
  under Node first.
- Schema changes after this point land in two adapters, gated by one
  contract suite and one migration list (the Rust side reads the same SQL).
- If the Rust adapter cannot pass the contract suite, option 1 remains the
  fallback without any change to the on-disk format.
- Independent of this decision, the approval-queue UI is built against an
  app-level `OuttrayApi` interface with a mock implementation, so UI work
  does not wait on sign-off.

## Amendment 1 (2026-10-16): identifiers in the app

Status: **accepted 2026-10-16 by Claude** under the project's autonomy rules
(`.claude/CLAUDE.md`). It refines how the app reaches the identifier vault
(ADR-0011) and reverses nothing above. It narrows what the page can read, so
the threat model gets stricter, not looser.

### Context

The CLI has `outtray settings` (the opt-in to remember ID numbers, off by
default) and `outtray reveal` (show one remembered number on request). The
app has neither, so a person using only the app can never opt in, and if they
opted in from the CLI they could never see a number in the app.

Building them the obvious way, with core's `revealIdentifier` in the page,
would send the full number through the store bridge into JavaScript. The
bridge already allows that today: `store_command` runs any store operation,
including `getIdentifier`, though nothing in the page calls it. The page
renders text the model extracted from documents, so it is the part of the app
most exposed to hostile content; it should not be able to read the vault at
all.

### Decision

1. **The page cannot read a full number.** `store_command` refuses
   `getIdentifier`. Every other operation the pipeline uses stays available,
   including writing and purging the vault.
2. **Reveal is a Rust command that shows the number in a native dialog.**
   `reveal_identifier(documentHash, field)` reads the value on the Rust side
   and shows it in a system message window. The page learns only whether a
   number was shown. It is one explicit act per number, as in the CLI.
3. **The setting is written by Rust, and switching it off purges there.**
   `write_settings` writes `config.json` the way core's `writeSettings` does
   (the whole file, owner-only, through a rename). Switching off then deletes
   every remembered number, as `setIdentifierStorage` does, but only when a
   database exists: turning the setting off never creates a store or a
   Keychain key as a side effect, which matches the CLI. Turning it **on**
   asks once more in a native confirmation dialog from the Rust side, so a
   page that misbehaves cannot opt the person in without their agreement.
4. **The app shows the same disclosure** before turning the setting on, with
   the reveal step named for the app. The wording lives in core with the
   CLI's, and the same tests pin every claim ADR-0011 requires.

### Options considered

1. **Reveal in the page** with core's `revealIdentifier`. Pros: no new Rust
   code. Cons: the full number enters JavaScript memory and the DOM, the
   bridge must keep `getIdentifier` open, and any script the page runs could
   read every number. Rejected.
2. **Copy to the clipboard from Rust.** Pros: the page never sees it. Cons:
   clipboard managers and history keep it indefinitely, and other apps read
   the clipboard freely. Worse than the terminal the CLI prints to. Rejected.
3. **Native dialog from Rust** (chosen). Pros: the number stays in the Rust
   process and the system window; the page cannot read it. Cons: a little
   Rust with no automated UI test; the dialog is not styled like the app.
4. **Leave settings and reveal CLI-only.** Pros: nothing to build. Cons: the
   app is the primary surface from Phase 3 on, and an opt-in nobody can reach
   from it is not a real choice. Rejected.

### Consequences

- `docs/THREAT_MODEL.md` records that the page cannot read the vault.
- The refusal is enforced in Rust and unit-tested there. Core's contract
  suite is unaffected: it reaches the Rust store through the stdio binary,
  not through the page's bridge.
- A screenshot taken while the dialog is open captures the number, the same
  as a terminal after `outtray reveal`. The dialog closes on dismissal and
  nothing keeps the value.
