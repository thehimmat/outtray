export {
  EXTRACTION_PROMPT,
  type ExtractInput,
  type ExtractResult,
  PROMPT_VERSION,
  extract,
} from './extract.js';
export {
  DOCUMENT_TYPES,
  type DocumentExtraction,
  type DocumentType,
  documentExtractionSchema,
  documentJsonSchema,
  validateExtraction,
} from './extraction-schema.js';
export {
  type ScanItem,
  type ScanOptions,
  type ScanReport,
  scanDirectory,
} from './scan.js';
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
export { cosineSimilarity, rankBySimilarity } from './vector.js';
