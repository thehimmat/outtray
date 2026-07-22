export { canonicalize, contractKey } from './contract.js';
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
  type Counts,
  compareField,
  type FieldVerdict,
  type Interval,
  type Proportion,
  precisionRecall,
  tally,
  wilson,
} from './score.js';
