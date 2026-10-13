/**
 * The desktop host: core in the webview, the store, key and files behind
 * Tauri commands (ADR-0013). Runs the same incremental pipeline as the CLI
 * (`scanWithStore`), so the app and `outtray scan` reuse, extract and save
 * identically, into the same store.
 *
 * Everything host-specific is injected (the IPC call, the folder picker, the
 * models, the date), so it is tested without a window.
 */

import {
  type DocumentSource,
  type EmbeddingProvider,
  explainStorageError,
  type ModelProvider,
  OllamaEmbeddingProvider,
  OllamaProvider,
  openCommandStorage,
  planActions,
  type StorageProvider,
  scanWithStore,
} from '@outtray/core';
import type { OuttrayApi, PlannedFolder } from './api.js';

/** Tauri's `invoke`, or a stand-in in tests. */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The models the pipeline uses (ADR-0002); the extraction model is named explicitly. */
export const EXTRACT_MODEL = 'qwen3-vl:2b';
export const EMBED_MODEL = 'nomic-embed-text';

export interface TauriApiDeps {
  invoke: Invoke;
  /** Show the folder picker; resolves null on cancel. */
  pickFolder: () => Promise<string | null>;
  models?: { provider: ModelProvider; embedder: EmbeddingProvider };
  today?: () => string;
}

/** A folder read through the shell's read-only commands. */
export function tauriFolderSource(invoke: Invoke, folder: string): DocumentSource {
  const locate = (name: string) => `${folder.replace(/\/+$/, '')}/${name}`;
  return {
    list: () => invoke<string[]>('list_folder', { folder }),
    read: async (name) =>
      new Uint8Array(await invoke<ArrayBuffer>('read_file', { path: locate(name) })),
    locate,
  };
}

function isUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch|ECONNREFUSED|network|Failed to fetch|Load failed/i.test(message);
}

/**
 * The desktop host.
 *
 * Failure modes: `planFolder` rejects with a plain-language Error when the
 * scan itself fails (the local model is not running). A store that cannot
 * be opened or written does not fail the plan; it becomes a note.
 */
export function tauriApi(deps: TauriApiDeps): OuttrayApi {
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  return {
    chooseFolder: deps.pickFolder,
    async planFolder(folder: string): Promise<PlannedFolder> {
      const models = deps.models ?? {
        provider: new OllamaProvider(),
        embedder: new OllamaEmbeddingProvider({ model: EMBED_MODEL }),
      };
      const notes: string[] = [];
      let storage: StorageProvider | null = null;
      try {
        storage = await openCommandStorage((op, args) =>
          op === 'open' ? deps.invoke('store_open') : deps.invoke('store_command', { op, args }),
        );
      } catch (error) {
        notes.push(
          `Not saved to the encrypted store: ${explainStorageError(error, 'the encrypted store')}`,
        );
      }
      const { identifierStorage } = await deps.invoke<{ identifierStorage: boolean }>(
        'read_settings',
      );
      try {
        const scan = await scanWithStore({
          ...models,
          source: tauriFolderSource(deps.invoke, folder),
          storage,
          identifierStorage,
          extractModel: EXTRACT_MODEL,
          embedModel: EMBED_MODEL,
        });
        if (scan.saved) {
          const unchanged =
            scan.saved.reused > 0 ? `, ${scan.saved.reused} unchanged since the last scan` : '';
          notes.push(
            `Saved ${scan.saved.documents} document(s) to the encrypted store${unchanged}.`,
          );
        } else if (storage) {
          notes.push(
            `Not saved to the encrypted store: ${explainStorageError(scan.saveError, 'the encrypted store')}`,
          );
        }
        if (scan.indexError) notes.push(`Search index not updated (${scan.indexError}).`);
        if (scan.report.classifierError) {
          notes.push(
            `Classifier unavailable (${scan.report.classifierError}); types are single-stage.`,
          );
        }
        return {
          folder,
          queue: planActions(scan.report, { today: today() }),
          scanned: scan.report.scanned.length,
          skipped: scan.report.skipped,
          notes,
        };
      } catch (error) {
        if (isUnreachable(error)) {
          throw new Error(
            `The local model is not running. Start Ollama (ollama serve) with ${EXTRACT_MODEL} and ${EMBED_MODEL} pulled, then try again.`,
          );
        }
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        await storage?.close();
      }
    },
  };
}
