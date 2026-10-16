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
export { contentHashOf, toBase64 } from './bytes.js';
export { CHUNKER_VERSION, type Chunk, type ChunkOptions, chunkText } from './chunk.js';
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
export { normalizeDate } from './dates.js';
export {
  APP_IDENTIFIER_STORAGE_DISCLOSURE,
  firstRunNotice,
  IDENTIFIER_STORAGE_DISCLOSURE,
} from './disclosure.js';
export { type DocumentSource, extensionOf } from './document-source.js';
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
export { derivedText, extractionText } from './extraction-text.js';
export {
  type FindOptions,
  type FindResult,
  findInSource,
  searchReport,
} from './find.js';
export {
  canonicalIdentifier,
  type DocumentIdentifier,
  IDENTIFIER_FIELDS,
  type IdentifierField,
  identifierOf,
  MIN_LAST_FOUR_LENGTH,
  MIN_MATCH_LENGTH,
  placeholderFor,
  redactExtraction,
  redactedForm,
  replaceIdentifier,
  replaceNearMisses,
  TOKENIZER_VERSION,
  tokenizeExtraction,
} from './identifiers.js';
export {
  type BuiltIndex,
  buildIndex,
  extractorKeyFor,
  indexKeyFor,
  type ReuseKeys,
  reusableDocument,
  reusedItem,
  type SearchScope,
  searchStore,
} from './incremental.js';
export type {
  GenerateOptions,
  GenerateRequest,
  GenerateResult,
  GenerateUsage,
  ModelProvider,
} from './model-provider.js';
export {
  OCR_CONTRACT,
  OCR_ENGINES,
  OcrContractError,
  OcrError,
  type OcrLine,
  type OcrResult,
  OcrResultSchema,
  OcrUnavailableError,
  ocrPlainText,
  parseOcrOutput,
} from './ocr-contract.js';
export {
  NonLoopbackHostError,
  OllamaProvider,
  type OllamaProviderOptions,
} from './ollama-provider.js';
export {
  type PersistOptions,
  type PersistSummary,
  persistScan,
} from './persist.js';
export {
  type CorrectionOutcome,
  correctDocument,
  PINNABLE_TYPES,
  personalClassifier,
  reuseOrPin,
} from './personalize.js';
export {
  type ScanWithStoreOptions,
  type ScanWithStoreResult,
  scanWithStore,
} from './pipeline.js';
export {
  applyCorrection,
  CLASSIFIER_K,
  CONFIDENCE_THRESHOLD,
  type Reconciliation,
  type ReconciliationStatus,
  reconcileType,
  userVerdict,
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
  isIdentifierField,
  locateDocument,
  type RevealResult,
  revealIdentifier,
} from './reveal.js';
export { type ReviewTarget, reviewTargets } from './review-marks.js';
export {
  type ClassifyStageOptions,
  type ReuseAnswer,
  type ScanItem,
  type ScanOptions,
  type ScanReport,
  scanSource,
} from './scan.js';
export {
  CommandStorage,
  openCommandStorage,
  type StorageTransport,
} from './storage-command.js';
export {
  DatabaseKeyError,
  explainStorageError,
  StorageCorruptError,
} from './storage-errors.js';
export { MemoryStorage } from './storage-memory.js';
export {
  asLabelProvenance,
  assertChunkBatch,
  type KeyedIdentifier,
  keyIdentifierBatch,
  type LabelProvenance,
  type NewLabel,
  StorageError,
  type StorageProvider,
  type StoredChunk,
  type StoredDocument,
  type StoredLabel,
  type StoredReview,
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
export { cosineSimilarity, rankBySimilarity } from './vector.js';
