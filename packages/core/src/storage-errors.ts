/**
 * What a damaged or busy store tells the user (#84).
 *
 * SQLite reports damage as `SQLITE_CORRUPT` or `SQLITE_NOTADB` and contention
 * as `SQLITE_BUSY`, in its own words ("database disk image is malformed").
 * Neither says the one thing that matters here: the store is a derived cache
 * of documents that are never modified (ADR-0007, ADR-0008), so the recovery
 * is always to delete it and re-scan. Every surface that reports a store
 * failure goes through `explainStorageError`, so that truth is said once.
 */

/** Thrown when the store file is structurally damaged (cut off, overwritten). */
export class StorageCorruptError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(damaged(path, detail));
    this.name = 'StorageCorruptError';
    this.path = path;
  }
}

function damaged(path: string, detail: string): string {
  return (
    `The encrypted store at ${path} is damaged (${detail}). It is only a cache and your ` +
    'documents are untouched, so delete it and re-scan.'
  );
}

/**
 * A store failure in the user's terms: damage and lock contention get the
 * recoverable truth, anything else keeps its own message.
 *
 * Failure modes: none; pure. Accepts any thrown value.
 */
export function explainStorageError(error: unknown, path: string): string {
  if (error instanceof StorageCorruptError) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === 'string') {
    if (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB') {
      return damaged(path, message);
    }
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      return 'Another Outtray command is using the store; try again when it finishes.';
    }
  }
  return message;
}
