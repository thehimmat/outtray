export { type Chunk, type ChunkOptions, chunkText } from './chunk.js';
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
} from './extract.js';
export {
  DOCUMENT_TYPES,
  type DocumentExtraction,
  type DocumentType,
  documentExtractionSchema,
  documentJsonSchema,
  validateExtraction,
} from './extraction-schema.js';
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
  type Citation,
  type DocumentText,
  type IndexedChunk,
  indexDocuments,
  type SourceRef,
  search,
  VectorIndex,
} from './retrieval.js';
export {
  type ScanItem,
  type ScanOptions,
  type ScanReport,
  scanDirectory,
} from './scan.js';
export { cosineSimilarity, rankBySimilarity } from './vector.js';
