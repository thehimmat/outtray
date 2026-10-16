import { describe, expect, it } from 'vitest';
import * as evals from './index.js';

describe('the @outtray/evals entry', () => {
  it('exports the extraction eval and the OCR eval side by side', () => {
    for (const name of ['RecordingProvider', 'runEval', 'scoreFixture', 'wilson', 'runOcrReport']) {
      expect(evals, name).toHaveProperty(name);
    }
  });
});
