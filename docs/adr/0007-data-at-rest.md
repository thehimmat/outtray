# ADR-0007: Data at rest and on-disk privacy posture

Status: accepted (encryption mechanism pending a spike). Date: 2026-07-21.

## Context

The extraction database concentrates a user's most sensitive information
(passport numbers, account numbers, contract terms) into a single file. A
privacy-marketed product cannot leave that file in plaintext without at least
an explicit, honest position. The primary threat in scope is a stolen or
accessed laptop (see THREAT_MODEL.md).

## Decision

- **Index in place; never copy originals.** The app stores only derived data
  (OCR text, extracted fields, embeddings, low-res thumbnails if needed) plus
  a content hash and path reference per document; moved files are re-resolved
  by hash. Deleting a document from the app purges its rows and embeddings in
  the same transaction, and the UI says so.
- **Encryption at rest is targeted at SQLCipher** (actively maintained;
  v4.17.0 shipped July 2026) with the key in the macOS Keychain. Note:
  `tauri-plugin-sql` has no encryption support (issue open since 2022), so the
  app will own its SQLite connection directly. A spike must prove the
  SQLCipher build path before Phase 1 storage code lands. Fallback if the
  spike fails: plain SQLite in a chmod-700 Application Support directory with
  a documented, honest "FileVault required, here is how to check" stance.
- **Locations and side channels:** the DB and all derived data live in
  `~/Library/Application Support/` (outside iCloud Documents sync scope);
  folder selection detects paths under iCloud Drive or synced Desktop/
  Documents and shows a one-time honest notice; Time Machine is named in the
  threat model as disclosed-but-out-of-scope retention; derived-text caches
  are excluded from Spotlight indexing.
- **Distribution: Developer ID plus notarization, no Mac App Store.** The MAS
  sandbox requires security-scoped bookmarks that Tauri core lacks
  (tauri#3716), and a "point at your messy folder" app is impractical under
  it. Folder access is granted exclusively through the native open-folder
  dialog; the app never requests Full Disk Access. The Apple Developer
  Program fee ($99/yr) is deferred until a real external tester exists.

## Consequences

- Encryption is decided before user data exists, so there is no migration of
  plaintext databases later.
- The honest-notice moments (iCloud overlap, FileVault stance) are trust
  artifacts competitors do not have, and they cost almost nothing.
