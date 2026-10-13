---
title: One encrypted store, two languages, one test suite
status: draft
phase: 3
audience: engineers adding a desktop shell to a TypeScript codebase, or keeping two implementations of one thing honest
---

# One encrypted store, two languages, one test suite

*Draft. Owner publishes. Not yet run on the target machine: see "What this
does not prove".*

Outtray reads a folder of personal documents on a laptop and proposes what to
do about them. Phases 1 and 2 shipped it as a command-line tool in
TypeScript, with an encrypted SQLite store. Phase 3 puts it in a desktop app.
The interesting part is not the window. It is what happened to the store.

## The choice that created a second implementation

The app is a Tauri shell: a native Rust process hosting a webview. The domain
code (extraction, classification, the action planner) is TypeScript, and the
target machine is an 8 GB MacBook Air on which the local model already takes
about 4 GB. There were four ways to get the TypeScript into the app:

1. **Ship Node inside the app as a sidecar process.** No code changes, but a
   second resident process, a 60 to 90 MB binary, and a native SQLCipher
   module to package and sign inside it.
2. **Run the TypeScript in the webview, and give it Rust adapters** for the
   things a webview cannot do: the encrypted store, the Keychain, the files.
3. **Port everything to Rust.** That would throw away the code every eval
   measures.
4. **Embed a JavaScript runtime in Rust.** Immature, and native modules still
   do not load.

Option 2 won (ADR-0013). Its cost was stated up front: the store now exists
twice. The CLI writes it from Node through `better-sqlite3-multiple-ciphers`;
the app writes it from Rust through `rusqlite` with bundled SQLCipher. Same
file on disk, same Keychain key, two codebases that must agree on every
read and write.

Two implementations of one thing drift. The question was how to make the
drift fail a build instead of corrupting someone's data.

## One suite, three stores

The store was already behind an interface, `StorageProvider`, with an
in-memory implementation for tests and the SQLCipher one for real. Both were
held to one contract suite: the same tests, run against each, so the fake
could never quietly disagree with the real thing.

The Rust store joined that suite instead of getting its own tests. It is a
small command layer, `handle(op, args)`, that takes one JSON command per
interface method. In the app, the commands arrive through Tauri's `invoke`.
In tests, they arrive through a tiny binary that reads the same JSON from
stdin. On the TypeScript side, `CommandStorage` turns each interface call into
one of those commands.

So the suite tests the Rust store through the exact boundary the app uses:
the TypeScript interface, serialized, over a transport, into Rust, and back.
Today that is 41 tests, run against all three stores on every pull request.
CI builds the Rust binary and sets a flag that turns a missing binary into a
failure rather than a silent skip, because a contract suite that skips one
implementation proves nothing about it.

The suite earned its keep later in the phase. Saving the app's "Reviewed"
marks needed a new table and three new methods. The tests were written
first, against the interface, and failed on all three stores until each one
implemented them. There was no separate step to remember for Rust.

## Same file, both directions

Passing the same tests is not the same as reading the same file. Two more
tests cover that: the Rust store reads what the Node store wrote and the
reverse, and a wrong key from the Rust side surfaces as the same key error
the Node side throws.

Those tests only pass because of a finding from a Phase 1 spike. The Node
driver's default cipher is not SQLCipher, and its default SQLCipher mode is
not compatible with upstream SQLCipher. Without `PRAGMA legacy = 4`, the file
is unreadable by any other SQLCipher implementation, and it leaks part of its
header in plaintext. The spike proved interop against the upstream command-line
tool. The store now asserts the cipher settings when it opens, both from the
driver and from the bytes on disk, so a dependency bump cannot change the
format without failing. Rust's bundled SQLCipher is upstream, so that one
setting is what makes "same file" true.

The schema had the same drift risk in a quieter form: migrations written
twice, once as TypeScript and once as Rust strings. They now live in one
file, `migrations.json`, read by the Node store and embedded into the Rust
binary at compile time. Adding the reviews table was one entry in that file.

## The trust boundary is the other half

Running the TypeScript in a webview changes who you trust. The webview renders
text extracted from documents, so a document is, in the worst case, a script
author. Three decisions follow from that:

- **The database key never reaches the page.** The Rust side reads it from the
  Keychain, or creates it there on first run, and opens the store itself. The
  page sends `store_open` with no arguments.
- **The page can only read folders the person picked.** The folder picker
  runs on the Rust side and records the folder. The read commands refuse
  everything else, after resolving symlinks and `..`. The page holds no
  dialog or file-system permission at all, so it cannot grant itself more.
- **Nothing writes, moves or deletes a document.** That was already the rule
  (the agent proposes, the person acts). The shell simply has no such
  command.

## A bug the boundary introduced

One bug came from the boundary itself, and a test caught it before it
shipped. The shell holds one open store. Two quick "Reviewed" ticks each
opened it, and the first to finish closed it under the second. The second
save failed with "Storage is closed". The fix is a few lines that run store
work one call at a time. The lesson is general: moving a resource behind IPC
turns an object you own into shared state you have to serialize.

## What this does not prove

- **It has not run on the Air.** CI builds the shell on Linux and macOS and
  runs its tests, but nobody has scanned a folder in the app on the target
  machine yet. The memory footprint of the app next to the model is
  unmeasured. That run is issue #127, and its numbers belong to the next
  post.
- **IPC cost is unmeasured.** Every store call is now a serialized round
  trip. At a personal corpus size this should not matter. "Should" is not a
  measurement.
- **The contract suite proves agreement, not correctness.** If all three
  stores share a misunderstanding, the suite passes. The cross-store tests
  and the on-disk format checks are there because agreement alone was not
  enough.

## What to take from it

- **Say the cost of a design out loud, then test the cost.** "The store
  exists twice" was in the decision record before any Rust was written, along
  with how it would be contained.
- **Test a second implementation through the boundary it will actually use.**
  A Rust unit-test suite would have been easier to write and would have
  missed every serialization mismatch.
- **One schema file, many readers.** Duplicate the code if you must, never
  the schema.
