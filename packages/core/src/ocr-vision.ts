/**
 * The Apple Vision OCR arm as a Node adapter (ADR-0002, issue #8).
 *
 * Runs the `outtray-ocr` sidecar built from `packages/ocr-vision` on one image
 * and validates what it prints against the `ocr-v1` contract. Vision ships
 * with macOS and runs on the Neural Engine, so this arm costs no model memory
 * against the 4 GB inference budget; that is the reason it is the primary
 * deterministic arm.
 *
 * Node-only (it spawns a process), so it is exported from `@outtray/core/node`.
 * The desktop app will run the same binary as a Tauri sidecar and parse its
 * output with the same `parseOcrOutput`.
 */

import { execFile } from 'node:child_process';
import { OcrError, type OcrResult, OcrUnavailableError, parseOcrOutput } from './ocr-contract.js';

/** The sidecar's name when it is on PATH. */
export const DEFAULT_OCR_BINARY = 'outtray-ocr';

/** A page that takes longer than this is treated as a hung sidecar. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Result of running the sidecar. `notFound` is set when the binary could not be spawned. */
export interface OcrRunResult {
  status: number;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

/** Runs the sidecar. Injected so every branch is testable without macOS. */
export type OcrRunner = (binary: string, args: readonly string[]) => Promise<OcrRunResult>;

export interface VisionOcrOptions {
  /** Path to the sidecar. Defaults to `outtray-ocr` on PATH. */
  binary?: string;
  /**
   * Let Vision correct recognized text toward dictionary words. Defaults to
   * true. It can rewrite identifier-like tokens, so #160 measures both.
   */
  languageCorrection?: boolean;
  /** Kill the sidecar after this long. Defaults to 60 s. */
  timeoutMs?: number;
  /** Injected runner (for tests). Defaults to the real subprocess. */
  run?: OcrRunner;
  /** Injected platform (for tests). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

function realRunner(timeoutMs: number): OcrRunner {
  return (binary, args) =>
    new Promise((resolve) => {
      execFile(
        binary,
        [...args],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolve({ status: 0, stdout, stderr });
          const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (err.code === 'ENOENT') {
            return resolve({ status: -1, stdout, stderr: err.message, notFound: true });
          }
          const status = typeof err.code === 'number' ? err.code : -1;
          const why = err.killed ? `killed after ${timeoutMs} ms` : stderr || err.message;
          resolve({ status, stdout, stderr: why });
        },
      );
    });
}

/** Text recognition through the Apple Vision sidecar. */
export class VisionOcr {
  readonly name = 'vision';
  readonly #binary: string;
  readonly #flags: readonly string[];
  readonly #run: OcrRunner;
  readonly #platform: NodeJS.Platform;

  constructor(options: VisionOcrOptions = {}) {
    this.#binary = options.binary ?? DEFAULT_OCR_BINARY;
    this.#flags = options.languageCorrection === false ? ['--no-language-correction'] : [];
    this.#run = options.run ?? realRunner(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#platform = options.platform ?? process.platform;
  }

  /**
   * Recognize the text in one image file (PNG, JPEG, HEIC, TIFF; first frame).
   *
   * Failure modes: rejects with `OcrUnavailableError` off macOS (without
   * spawning anything) or when the sidecar binary is not found; with
   * `OcrError` when the sidecar exits non-zero (unreadable image, Vision
   * failure, timeout), carrying its exit status and stderr; with
   * `OcrContractError` when its output is not a valid `ocr-v1` result.
   */
  async recognize(path: string): Promise<OcrResult> {
    if (this.#platform !== 'darwin') {
      throw new OcrUnavailableError(
        `The Vision OCR arm needs macOS; this is ${this.#platform}. Tesseract is the portable ` +
          'arm (ADR-0002) and is not built yet.',
      );
    }
    const result = await this.#run(this.#binary, [...this.#flags, path]);
    if (result.notFound) {
      throw new OcrUnavailableError(
        `The OCR sidecar ${this.#binary} was not found. Build it with ` +
          '`swift build -c release --package-path packages/ocr-vision`.',
      );
    }
    if (result.status !== 0) {
      throw new OcrError(
        `The OCR sidecar failed on ${path} (exit ${result.status}): ` +
          `${result.stderr.trim() || 'no output'}`,
      );
    }
    return parseOcrOutput(result.stdout);
  }
}
