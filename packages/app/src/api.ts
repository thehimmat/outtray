/**
 * What the UI asks of its host (ADR-0013).
 *
 * The UI depends on this interface only. In the desktop app it is backed by
 * core running in the webview with Rust adapters (storage, Keychain, files);
 * until those land, `demo-api.ts` backs it with the real core planner over
 * synthetic documents. Nothing here acts on the user's files: the agent
 * proposes, the human acts (ADR-0008).
 */

import type { ActionQueue, Citation, CorrectionOutcome, DocumentType } from '@outtray/core';

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
  /** Ids of the queue items the person marked reviewed on an earlier run. */
  reviewed: string[];
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
  /**
   * Save or clear the person's "Reviewed" mark on one item of the last
   * planned folder (ADR-0010 amendment 1). Changes no document.
   *
   * Failure modes: rejects with an Error whose message is shown to the user
   * when the mark cannot be saved (the store cannot be opened, or the item's
   * document is not in it).
   */
  setReviewed(itemId: string, reviewed: boolean): Promise<void>;
  /**
   * Pin the type of the document behind one item of the last planned folder,
   * as `outtray correct` does (#67): the pin wins over the classifier from
   * now on, and the correction becomes an example it learns from. The queue
   * changes on the next plan. Changes no document.
   *
   * Failure modes: rejects with an Error whose message is shown to the user
   * when the type cannot be pinned (`unknown`), the item is not in the last
   * plan, its document was not saved, or the store cannot be opened or
   * written.
   */
  setDocumentType(itemId: string, type: DocumentType): Promise<CorrectionOutcome>;
  /**
   * The passages of the last planned folder's documents that best match
   * `query`, as `outtray find` ranks them (ADR-0005, ADR-0012). Passages are
   * tokenized derived text, so they never carry a full identifier
   * (ADR-0011). A blank query resolves `[]` without loading a model.
   *
   * Failure modes: rejects with an Error whose message is shown to the user
   * before any folder is planned, or when the embedding model is unreachable.
   */
  search(query: string): Promise<Citation[]>;
}
