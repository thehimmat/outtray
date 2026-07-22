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
  RecordingProvider,
  type RecordingProviderOptions,
  type RecordMode,
  StaleRecordingError,
} from './recording-provider.js';
export {
  type Aggregate,
  type EvalReport,
  type FieldScore,
  type FixtureScore,
  runEval,
  scoreFixture,
} from './run-eval.js';
export {
  type Counts,
  compareField,
  type FieldVerdict,
  type Interval,
  type Proportion,
  precisionRecall,
  tally,
  wilson,
} from './score.js';
