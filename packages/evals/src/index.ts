export {
  type Accuracy,
  type ClassifyReport,
  type ClassifyRow,
  classifyEval,
  tallyClassification,
} from './classify-eval.js';
export { canonicalize, contractKey } from './contract.js';
export { SCORED_FIELDS } from './field-kinds.js';
export {
  type FixtureLabels,
  type FixtureSpec,
  generateFixtures,
} from './fixtures/generate.js';
export {
  fixturesRoot,
  type LoadedFixture,
  loadFixture,
  loadManifest,
  type Manifest,
  type ManifestEntry,
  type ManifestFile,
  verifyManifest,
} from './fixtures/load.js';
export { sha256Hex } from './hash.js';
export {
  type FieldKind,
  normalizeAmount,
  normalizeDate,
  normalizeText,
  normalizeValue,
} from './normalize.js';
export {
  type DegradedManifest,
  findField,
  htmlVisibleText,
  IDENTIFIER_FIELDS,
  loadDegradedManifest,
  loadOcrPages,
  OCR_LEVELS,
  OCR_VARIANTS,
  type OcrFieldScore,
  type OcrFixtureScore,
  type OcrLevel,
  type OcrPage,
  type OcrPageScore,
  type OcrRecording,
  type OcrSummary,
  type OcrVariant,
  ocrRecordingsDir,
  type PageRecognizer,
  recordingPath,
  replayRecognizer,
  runOcrReport,
  scoreOcrFixture,
  summarizeByLevel,
  summarizeOcr,
  verifyDegradedManifest,
  wordRecall,
} from './ocr-eval.js';
