/**
 * What the UI asks of its host (ADR-0013).
 *
 * The UI depends on this interface only. In the desktop app it is backed by
 * core running in the webview with Rust adapters (storage, Keychain, files);
 * until those land, `demo-api.ts` backs it with the real core planner over
 * synthetic documents. Nothing here acts on the user's files: the agent
 * proposes, the human acts (ADR-0008).
 */

import type { ActionQueue } from '@outtray/core';

/** One planned folder. */
export interface PlannedFolder {
  /** The folder the queue was planned for, as shown to the user. */
  folder: string;
  queue: ActionQueue;
  /** How many documents were read. */
  scanned: number;
  /** How many files were not documents Outtray reads (and why it matters: they were not looked at). */
  skipped: string[];
  /** Plain-language notes about the run (store saved, classifier unavailable). */
  notes: string[];
}

/** The host the UI runs against. */
export interface OuttrayApi {
  /**
   * Ask the user for a folder. Resolves null when they cancel.
   *
   * Failure modes: rejects only if the host cannot show a picker.
   */
  chooseFolder(): Promise<string | null>;
  /**
   * Read the folder and plan its action queue.
   *
   * Failure modes: rejects with an Error whose message is shown to the user,
   * for example when the local model runtime is not running.
   */
  planFolder(folder: string): Promise<PlannedFolder>;
}
