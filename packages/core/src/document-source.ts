/**
 * Where a scan reads documents from (ADR-0013).
 *
 * Core runs in two hosts: Node for the CLI, and the Tauri webview for the app,
 * which has no `node:fs`. A scan therefore reads through this interface, and
 * each host supplies its own: `folderSource` in `@outtray/core/node`, a Tauri
 * file-API source in the app. Documents are read, never written (ADR-0008).
 */

/** A folder of documents to scan. */
export interface DocumentSource {
  /**
   * The names of the files directly in the folder (not subfolders), in any
   * order; the scan sorts them.
   *
   * Failure modes: rejects if the folder cannot be read.
   */
  list(): Promise<string[]>;
  /**
   * The bytes of one listed file.
   *
   * Failure modes: rejects if the file cannot be read.
   */
  read(name: string): Promise<Uint8Array>;
  /**
   * The absolute location recorded for a file, so a stored document says
   * where it was last seen. Pure; never touches the filesystem.
   */
  locate(name: string): string;
}

/**
 * The extension of a file name, lowercased and with its dot (`.png`), or ''
 * when it has none. A host-neutral stand-in for `path.extname`.
 *
 * Failure modes: none; pure.
 */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}
