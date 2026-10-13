/**
 * Write a scan into the store, and switch identifier storage on or off
 * (ADR-0011 section 3 and its 2026-09-30 amendment).
 *
 * The rules this module exists to keep in one place:
 *
 * - The stored extraction is always the redacted form, whatever the setting,
 *   so the documents table never holds a full identifier and never needs a
 *   rewrite when the setting changes.
 * - Full values reach the vault only when the user opted in.
 * - Off means an empty vault. Every persist with the setting off purges, so a
 *   purge that failed when the setting was switched off is completed on the
 *   next scan rather than leaving values behind.
 * - A fresh document is marked indexed only after its chunks are written; a
 *   reused one keeps its chunks and vault rows and only moves (ADR-0012).
 */

import { resolve } from 'node:path';
import { identifierOf, redactExtraction } from './identifiers.js';
import type { ScanReport } from './scan.js';
import { writeSettings } from './settings.js';
import type { StorageProvider, StoredChunk } from './storage-provider.js';

/** Options for `persistScan`. */
export interface PersistOptions {
  /** The scanned directory, so stored paths are absolute. */
  dir: string;
  /** The user's opt-in, from `readSettings`. */
  identifierStorage: boolean;
  /** Timestamp to record, in milliseconds since the epoch. Defaults to now. */
  now?: number;
  /** Which model and prompts produced the fresh extractions (ADR-0012). */
  extractorKey?: string;
  /**
   * The chunks `buildIndex` made for this scan and the key they were built
   * under. Omitted when there is no index (no embedder, or it failed): fresh
   * documents are then saved unindexed and extracted again next time.
   */
  index?: { key: string; chunks: ReadonlyMap<string, StoredChunk[]> };
}

/** What a persist wrote. */
export interface PersistSummary {
  /** Documents written or replaced. */
  documents: number;
  /** Of those, documents reused from the store rather than extracted (ADR-0012). */
  reused: number;
  /** Freshly extracted documents written with their chunks and index key. */
  indexed: number;
  /** Documents whose identifier was vaulted (0 when the setting is off). */
  identifiersVaulted: number;
  /** Identifiers deleted because the setting is off (normally 0). */
  identifiersPurged: number;
}

/**
 * Write every scanned document to `storage`, keyed by content hash.
 *
 * Failure modes: rejects if the store rejects a write (closed, or the
 * database refuses it). Documents written before the failure stay written;
 * each is a complete row, and a re-scan replaces them. A document whose
 * chunks failed to write is left with a null index key, so the next scan
 * extracts it again. When the setting is
 * off, the purge runs first, so a failure after it cannot leave a vault
 * behind that the setting says should not exist.
 */
export async function persistScan(
  storage: StorageProvider,
  report: ScanReport,
  options: PersistOptions,
): Promise<PersistSummary> {
  const scannedAt = options.now ?? Date.now();
  const identifiersPurged = options.identifierStorage ? 0 : await storage.purgeIdentifiers();

  let identifiersVaulted = 0;
  let reused = 0;
  let indexed = 0;
  for (const { file, contentHash, result, reconciliation, reused: isReused } of report.items) {
    const doc = result.document;
    const row = {
      contentHash,
      path: resolve(options.dir, file),
      type: doc ? reconciliation.effectiveType : null,
      // Idempotent, so a reused (already redacted) extraction passes unchanged.
      extraction: doc ? redactExtraction(doc) : null,
      reconciliation: reconciliation.status === 'unclassified' ? null : reconciliation,
      scannedAt,
      extractorKey: options.extractorKey ?? null,
    };

    if (isReused) {
      // Reuse means both keys matched (ADR-0012 section 2): only the path and
      // scan time are new. Chunks and the vault were written when it was
      // extracted, and a redacted extraction has nothing left to vault.
      const prior = await storage.getDocument(contentHash);
      await storage.putDocument({
        ...row,
        extractorKey: prior?.extractorKey ?? null,
        indexKey: prior?.indexKey ?? null,
      });
      reused += 1;
      continue;
    }

    // Unindexed until its chunks are written, so a failure part way leaves a
    // document that is extracted again rather than one claiming an index.
    await storage.putDocument({ ...row, indexKey: null });
    if (options.identifierStorage) {
      const id = doc ? identifierOf(doc) : null;
      // Replace, so a value this scan no longer finds is not left revealable.
      await storage.putIdentifiers(contentHash, id ? [id] : []);
      if (id) identifiersVaulted += 1;
    }
    // Replace, so chunks of an older extraction never outlive it.
    await storage.putChunks(contentHash, (doc && options.index?.chunks.get(contentHash)) || []);
    if (doc && options.index) {
      await storage.putDocument({ ...row, indexKey: options.index.key });
      indexed += 1;
    }
  }
  return {
    documents: report.items.length,
    reused,
    indexed,
    identifiersVaulted,
    identifiersPurged,
  };
}

/** Options for `setIdentifierStorage`. */
export interface SetIdentifierStorageOptions {
  /** Where the settings live, normally `defaultConfigPath()`. */
  configPath: string;
  /**
   * The store to purge when switching off, or null when no store exists yet
   * (nothing to purge, and opening one would create it).
   */
  storage: StorageProvider | null;
  enabled: boolean;
}

/**
 * Record the user's identifier-storage choice, purging the vault when it is
 * switched off. Switching on changes nothing in the store: values already
 * redacted are gone, and reach the vault when their documents are next
 * extracted (ADR-0011 amendment, section 3).
 *
 * Failure modes: rejects if the settings file cannot be written, in which
 * case nothing is purged and the old setting stands. If the setting is
 * written but the purge rejects, the setting is off and the next
 * `persistScan` completes the purge. A null `storage` purges nothing, which
 * is complete when no store exists.
 */
export async function setIdentifierStorage(
  options: SetIdentifierStorageOptions,
): Promise<{ purged: number }> {
  await writeSettings(options.configPath, { identifierStorage: options.enabled });
  if (options.enabled || options.storage === null) return { purged: 0 };
  return { purged: await options.storage.purgeIdentifiers() };
}
