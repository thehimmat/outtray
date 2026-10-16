/**
 * The OCR arm's output contract (ADR-0002: "the sidecar's output contract is
 * defined with a Zod schema like everything else").
 *
 * The Apple Vision sidecar (`packages/ocr-vision`, issue #8) prints one JSON
 * object on stdout per image. This module is the TypeScript side of that
 * contract: the schema, a parser that refuses anything else, and the plain
 * text the pipeline reads from it. It is host-neutral; running the sidecar is
 * the Node adapter's job (`ocr-vision.ts`, exported from `@outtray/core/node`).
 *
 * Coordinates are normalized to the page (0..1) with the origin at the top
 * left, the way a person reads a page. Vision's own origin is bottom left; the
 * sidecar converts, so nothing downstream has to remember which way is up.
 *
 * The contract is versioned by `contract`. The schema is strict, so a sidecar
 * that adds or renames a field fails here until the version and this schema
 * move together.
 */

import { z } from 'zod';

/** The contract version this build reads. The sidecar prints the same string. */
export const OCR_CONTRACT = 'ocr-v1';

/** The Vision request that produced the text. */
export const OCR_ENGINES = ['vision-recognize-text', 'vision-recognize-documents'] as const;

const unit = z.number().min(0).max(1);

const box = z
  .object({ x: unit, y: unit, width: unit, height: unit })
  .strict()
  .describe('Normalized to the page, origin top left');

const line = z
  .object({
    text: z.string().min(1),
    confidence: unit,
    box,
  })
  .strict();

const page = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    lines: z.array(line),
  })
  .strict();

/** One image's recognized text, as the sidecar prints it. */
export const OcrResultSchema = z
  .object({
    contract: z.literal(OCR_CONTRACT),
    engine: z.enum(OCR_ENGINES),
    engineRevision: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    pages: z.array(page).min(1),
  })
  .strict();

export type OcrResult = z.infer<typeof OcrResultSchema>;
export type OcrLine = OcrResult['pages'][number]['lines'][number];

/** The sidecar printed something that is not an `ocr-v1` result. */
export class OcrContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrContractError';
  }
}

/** The OCR arm cannot run here (wrong platform, or the sidecar is not installed). */
export class OcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

/** The sidecar ran and failed (unreadable image, Vision error, timeout). */
export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrError';
  }
}

/**
 * Parse and validate the sidecar's stdout.
 *
 * Failure modes: throws `OcrContractError` when the text is not JSON, when its
 * `contract` is not `OCR_CONTRACT` (the message names both versions, so a
 * stale sidecar binary is obvious), or when any field fails the schema. Never
 * returns a partial result.
 */
export function parseOcrOutput(stdout: string): OcrResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new OcrContractError(
      `The OCR sidecar did not print JSON. Its output began: ${JSON.stringify(stdout.slice(0, 120))}`,
    );
  }
  const version = (raw as { contract?: unknown } | null)?.contract;
  if (version !== OCR_CONTRACT) {
    throw new OcrContractError(
      `The OCR sidecar speaks ${JSON.stringify(version)}, this build reads ${OCR_CONTRACT}. ` +
        'Rebuild the sidecar from packages/ocr-vision.',
    );
  }
  const parsed = OcrResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OcrContractError(
      `The OCR sidecar's output does not match ${OCR_CONTRACT}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * The recognized text, one line per OCR line in the sidecar's reading order,
 * pages separated by a blank line.
 *
 * Failure modes: none; a page with no lines contributes an empty string.
 */
export function ocrPlainText(result: OcrResult): string {
  return result.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n\n');
}
