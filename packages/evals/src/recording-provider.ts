/**
 * Record and replay `ModelProvider` calls (METHODOLOGY.md).
 *
 * `pnpm eval:record` runs this in `record` mode on the dev machine: it calls a
 * real provider and writes each response to disk keyed by the contract hash.
 * CI runs `replay` mode: it reads the committed recording for a request's key
 * and never touches a model. A missing recording is a hard error ("stale
 * recording, run pnpm eval:record"), so replay proves the committed recordings
 * still correspond to the current prompts, schemas, model, and params.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenerateRequest, GenerateResult, ModelProvider } from '@outtray/core';
import { contractKey } from './contract.js';

export type RecordMode = 'record' | 'replay';

/** Thrown in replay mode when no committed recording matches a request's contract key. */
export class StaleRecordingError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Stale or missing recording for contract ${key}. Run 'pnpm eval:record'.`);
    this.name = 'StaleRecordingError';
    this.key = key;
  }
}

export interface RecordingProviderOptions {
  /** Directory of `<key>.json` recordings. */
  dir: string;
  /** `record` calls `inner` and writes; `replay` reads only. */
  mode: RecordMode;
  /** The real provider to record from. Required in `record` mode, ignored in `replay`. */
  inner?: ModelProvider;
}

/** A stored recording: the result plus a human-readable summary of the request. */
interface Recording {
  key: string;
  request: {
    model: string | undefined;
    promptChars: number;
    imageCount: number;
    hasFormat: boolean;
    options: GenerateRequest['options'];
  };
  result: GenerateResult;
}

export class RecordingProvider implements ModelProvider {
  readonly name = 'recording';
  readonly #dir: string;
  readonly #mode: RecordMode;
  readonly #inner: ModelProvider | undefined;

  constructor(options: RecordingProviderOptions) {
    this.#dir = options.dir;
    this.#mode = options.mode;
    this.#inner = options.inner;
  }

  /**
   * Failure modes: in `replay`, throws `StaleRecordingError` when no recording
   * matches the request. In `record`, throws if no inner provider was given, or
   * rejects if the inner provider does. Never falls back to a live call in
   * replay mode: a missing recording must fail CI, not silently hit a model.
   */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const key = contractKey(req);
    const file = join(this.#dir, `${key}.json`);

    if (this.#mode === 'replay') {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        throw new StaleRecordingError(key);
      }
      return (JSON.parse(raw) as Recording).result;
    }

    if (!this.#inner) {
      throw new Error("RecordingProvider 'record' mode requires an inner provider.");
    }
    const result = await this.#inner.generate(req);
    const recording: Recording = {
      key,
      request: {
        model: req.model,
        promptChars: req.prompt.length,
        imageCount: req.images?.length ?? 0,
        hasFormat: req.format !== undefined,
        options: req.options,
      },
      result,
    };
    await mkdir(this.#dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);
    return result;
  }
}
