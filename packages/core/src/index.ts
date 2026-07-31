export {
  type ActionCitation,
  type ActionItem,
  type ActionKind,
  type ActionQueue,
  DISCLAIMER,
  type PlanOptions,
  planActions,
  type RetentionAdvice,
} from './actions.js';
export {
  APP_DIRECTORY,
  APP_DIRECTORY_MODE,
  type AppPathOptions,
  appDataDir,
  DATABASE_FILE,
  DATABASE_FILE_MODE,
  defaultDatabasePath,
  ensureAppDataDir,
  UnsupportedPlatformError,
} from './app-paths.js';
export { type Chunk, type ChunkOptions, chunkText } from './chunk.js';
export {
  type Classification,
  type LabeledExample,
  TypeClassifier,
} from './classifier.js';
export {
  buildClassifier,
  classifyText,
  SEED_EXAMPLES,
  type SeedExample,
} from './classifier-seeds.js';
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
  type EmbeddingProvider,
  OllamaEmbeddingProvider,
  type OllamaEmbeddingProviderOptions,
} from './embedding-provider.js';
export {
  EXTRACTION_PROMPT,
  type ExtractInput,
  type ExtractResult,
  extract,
  PROMPT_VERSION,
  TYPED_PROMPT_VERSION,
  typedExtractionPrompt,
} from './extract.js';
export {
  DOCUMENT_TYPES,
  type DocumentExtraction,
  type DocumentType,
  documentExtractionSchema,
  documentJsonSchema,
  documentJsonSchemaFor,
  validateExtraction,
} from './extraction-schema.js';
export { extractionText } from './extraction-text.js';
export {
  type FindOptions,
  type FindResult,
  findInDirectory,
} from './find.js';
export type {
  GenerateOptions,
  GenerateRequest,
  GenerateResult,
  GenerateUsage,
  ModelProvider,
} from './model-provider.js';
export {
  NonLoopbackHostError,
  OllamaProvider,
  type OllamaProviderOptions,
} from './ollama-provider.js';
export {
  applyCorrection,
  CLASSIFIER_K,
  CONFIDENCE_THRESHOLD,
  type Reconciliation,
  type ReconciliationStatus,
  reconcileType,
} from './reconcile.js';
export {
  type Citation,
  type DocumentText,
  type IndexedChunk,
  indexDocuments,
  type SourceRef,
  search,
  VectorIndex,
} from './retrieval.js';
export {
  type ClassifyStageOptions,
  type ScanItem,
  type ScanOptions,
  type ScanReport,
  scanDirectory,
} from './scan.js';
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
export { MemoryStorage } from './storage-memory.js';
export {
  asLabelProvenance,
  assertChunkBatch,
  type LabelProvenance,
  type NewLabel,
  StorageError,
  type StorageProvider,
  type StoredChunk,
  type StoredDocument,
  type StoredLabel,
} from './storage-provider.js';
export {
  decodeEmbedding,
  encodeEmbedding,
  MIGRATIONS,
  type Migration,
  pendingMigrations,
  SCHEMA_VERSION,
  StorageMigrationError,
} from './storage-schema.js';
export {
  type OpenSqlcipherStorageOptions,
  openSqlcipherStorage,
  SqlcipherStorage,
} from './storage-sqlcipher.js';
export { cosineSimilarity, rankBySimilarity } from './vector.js';
