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
export { cosineSimilarity, rankBySimilarity } from './vector.js';
