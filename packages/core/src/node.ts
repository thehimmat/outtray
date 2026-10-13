/**
 * `@outtray/core/node`: the Node host's adapters (ADR-0013).
 *
 * `@outtray/core` is host-neutral so it runs in the Tauri webview as well as
 * under Node. Everything that needs Node lives here instead: the folder
 * source, the SQLCipher store (a native module), the Keychain key provider
 * (spawns `security`), the settings file and the app paths. The CLI imports
 * both entries; the app imports only the neutral one and supplies its own
 * Rust-backed adapters.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DocumentSource } from './document-source.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { type FindOptions, type FindResult, findInSource } from './find.js';
import type { ModelProvider } from './model-provider.js';
import { locateDocument } from './reveal.js';
import { type ScanOptions, type ScanReport, scanSource } from './scan.js';
import type { StorageProvider, StoredDocument } from './storage-provider.js';

/**
 * A folder on disk as a `DocumentSource`: the regular files directly in it,
 * located by their absolute path.
 *
 * Failure modes: `list` rejects if the folder cannot be read; `read` rejects
 * if a file cannot be. Creating the source touches nothing.
 */
export function folderSource(dir: string): DocumentSource {
  return {
    async list() {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    },
    read: (name) => readFile(join(dir, name)),
    locate: (name) => resolve(dir, name),
  };
}

/**
 * `scanSource` over a folder on disk.
 *
 * Failure modes: as `scanSource`; rejects if `dir` cannot be read.
 */
export function scanDirectory(
  provider: ModelProvider,
  dir: string,
  options?: ScanOptions,
): Promise<ScanReport> {
  return scanSource(provider, folderSource(dir), options);
}

/**
 * `findInSource` over a folder on disk.
 *
 * Failure modes: as `findInSource`.
 */
export function findInDirectory(
  model: ModelProvider,
  embedder: EmbeddingProvider,
  dir: string,
  query: string,
  k: number,
  options?: FindOptions,
): Promise<FindResult> {
  return findInSource(model, embedder, folderSource(dir), query, k, options);
}

/**
 * `locateDocument` for a path on disk, relative paths resolved against the
 * working directory.
 *
 * Failure modes: as `locateDocument`.
 */
export function locateFile(storage: StorageProvider, path: string): Promise<StoredDocument | null> {
  return locateDocument(storage, resolve(path), (p) => readFile(p));
}

export {
  APP_DIRECTORY,
  APP_DIRECTORY_MODE,
  type AppPathOptions,
  appDataDir,
  CONFIG_FILE,
  DATABASE_FILE,
  DATABASE_FILE_MODE,
  defaultConfigPath,
  defaultDatabasePath,
  ensureAppDataDir,
  UnsupportedPlatformError,
} from './app-paths.js';
export {
  DATABASE_KEY_BYTES,
  type DatabaseKey,
  DatabaseKeyError,
  type DatabaseKeyProvider,
  generateDatabaseKey,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  KeychainKeyProvider,
  type KeychainKeyProviderOptions,
  type SecurityResult,
  type SecurityRunner,
  StaticKeyProvider,
} from './db-key.js';
export {
  DEFAULT_SETTINGS,
  readSettings,
  type SetIdentifierStorageOptions,
  type Settings,
  type SettingsRead,
  setIdentifierStorage,
  writeSettings,
} from './settings.js';
export {
  assertCipherPragmas,
  assertEncryptedHeader,
  CIPHER_PRAGMAS,
  EXPECTED_CIPHER,
  EXPECTED_LEGACY,
  HEADER_BYTES,
  hasCleartextSqliteHeader,
  type PragmaReader,
  readPragmaScalar,
  StorageFormatError,
} from './storage-format.js';
export {
  type OpenSqlcipherStorageOptions,
  openSqlcipherStorage,
  SqlcipherStorage,
} from './storage-sqlcipher.js';
