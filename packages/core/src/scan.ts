/**
 * Scan a directory of documents into a report of extractions (ADR-0002,
 * ADR-0008, ADR-0009).
 *
 * Reads the image files in a directory and runs each through `extract` with the
 * injected provider, strictly one at a time. Sequential by design: only one
 * model is resident at a time on the 8 GB target (ADR-0002), so there is no
 * benefit to overlapping calls and real cost to the memory spike. The agent
 * only proposes; nothing here mutates the scanned files (ADR-0008).
 *
 * With a `classify` option, a second stage runs after all extractions: the
 * embedder loads once, embeds every valid document's extraction text, and the
 * ADR-0009 k-NN classifier votes on each type. Stages are batched by model,
 * not interleaved per document, so the VLM and the embedder are never resident
 * together. Each item then carries a `Reconciliation` verdict. Per the
 * accepted ADR-0009 amendment, a third stage re-extracts each disputed
 * document exactly once under the classifier's type-specific schema and
 * upgrades it to `corrected` when the result validates as that type; anything
 * else stays `disputed` for human review.
 *
 * Given an OCR recognizer as well, the classifier runs first on the OCR text
 * and routes confidently known documents to the typed prompt (ADR-0009
 * amendment 3); the order above remains the path for pages the OCR could not
 * read. Image files only; PDF rendering lands later. Non-image files are
 * reported as skipped, not errors.
 */

import { contentHashOf, toBase64 } from './bytes.js';
import type { Classification, TypeClassifier } from './classifier.js';
import { buildClassifier } from './classifier-seeds.js';
import { type DocumentSource, extensionOf } from './document-source.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { type ExtractResult, extract } from './extract.js';
import type { DocumentType } from './extraction-schema.js';
import { derivedText } from './extraction-text.js';
import type { ModelProvider } from './model-provider.js';
import { type OcrResult, ocrPlainText } from './ocr-contract.js';
import { assessReadability, type UnreadableReason } from './ocr-readability.js';
import {
  applyCorrection,
  CLASSIFIER_K,
  CONFIDENCE_THRESHOLD,
  type Reconciliation,
  reconcileType,
  routedVerdict,
  userVerdict,
} from './reconcile.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * Version of the classify-first routing rules and the readability thresholds
 * they rely on (ADR-0009 amendment 3). Part of the extractor key when OCR is
 * on; bump it when either changes.
 */
export const ROUTING_VERSION = 'classify-first-v1';

/**
 * Reads a document's text before extraction (ADR-0009 amendment 3). The host
 * supplies one: `VisionOcr` behind `visionRecognizer` in `@outtray/core/node`.
 */
export interface OcrRecognizer {
  /**
   * What produced the text (contract, engine, flags), for the extractor key
   * (ADR-0012): a different recognizer can route a document differently.
   */
  readonly key: string;
  /**
   * Recognize the text of one listed file.
   *
   * Failure modes: rejects when the file cannot be read; the scan records the
   * reason on the item and extracts it without OCR.
   */
  recognize(file: string): Promise<OcrResult>;
}

/** What the OCR made of one document, kept on its item. */
export interface OcrOutcome {
  /** Whether the OCR read it well enough to classify from (#163); false on an error. */
  readable: boolean;
  /** Why it was judged unreadable, across its pages; empty when readable or on an error. */
  reasons: UnreadableReason[];
  /** Why the OCR failed on this file, or null. */
  error: string | null;
}

/** One scanned document and its extraction. */
export interface ScanItem {
  /** File name relative to the scanned directory. */
  file: string;
  /**
   * SHA-256 of the file's bytes, hex. The store's document key (ADR-0011): a
   * moved or renamed file is the same document, an edited one is a new one.
   */
  contentHash: string;
  /** The extraction outcome (may be invalid; see `ExtractResult`). */
  result: ExtractResult;
  /** The type verdict after the classification stage (ADR-0009). */
  reconciliation: Reconciliation;
  /**
   * Set when the item was rebuilt from the store instead of extracted
   * (ADR-0012). Its `result.document` is then the stored, redacted
   * extraction, and it skipped classification and typed re-extraction.
   */
  reused?: true;
  /**
   * Set when the user pinned this document's type (#67): it was extracted
   * under that type's schema and skipped classification.
   */
  pinned?: true;
  /** Set when the OCR read the file before extraction (ADR-0009 amendment 3). */
  ocr?: OcrOutcome;
}

/** A file hashed and offered to the reuse hook, waiting to be extracted. */
interface Planned {
  file: string;
  contentHash: string;
  answer: ReuseAnswer;
}

/** What a reuse hook can answer for one file. */
export type ReuseAnswer =
  /** Reuse this item; no model call. */
  | ScanItem
  /** Extract it under this type's schema; the user pinned the type (#67). */
  | { extractAs: DocumentType }
  /** Extract it as usual. */
  | null;

/** The result of scanning a directory. */
export interface ScanReport {
  /** Image files that were extracted, in sorted order. */
  scanned: string[];
  /** Non-image files that were skipped. */
  skipped: string[];
  /** One item per scanned file. */
  items: ScanItem[];
  /**
   * Why the classification stage produced no verdicts, or null when it ran
   * (or was not configured). When set, items keep single-stage VLM labels.
   */
  classifierError: string | null;
}

/** Configuration for the ADR-0009 classification stage of a scan. */
export interface ClassifyStageOptions {
  /** Embeds extraction texts (and seeds, unless a classifier is injected). */
  embedder: EmbeddingProvider;
  /**
   * Prebuilt classifier, or a factory for one (seeds plus the user's stored
   * corrections, #67). A factory is called only when something needs
   * classifying, so a scan where every file is reused loads no embedder.
   * Defaults to one built from `SEED_EXAMPLES` with `embedder`.
   */
  classifier?: TypeClassifier | (() => Promise<TypeClassifier>);
  /** Neighbors per vote; defaults to `CLASSIFIER_K`. */
  k?: number;
  /** Confidence cutoff for reconciliation; defaults to `CONFIDENCE_THRESHOLD`. */
  threshold?: number;
}

/** Options for a directory scan. */
export interface ScanOptions {
  /** Model tag override passed to each extraction. */
  model?: string;
  /** Run the ADR-0009 classification stage after extraction. */
  classify?: ClassifyStageOptions;
  /**
   * Offered each file's content hash before extraction (ADR-0012, #67): reuse
   * a stored item, extract under a pinned type, or extract as usual.
   */
  reuse?: (file: string, contentHash: string) => Promise<ReuseAnswer>;
  /**
   * Read new documents' text first and classify from it (ADR-0009 amendment
   * 3). Used only with `classify`; ignored without it.
   */
  ocr?: OcrRecognizer;
}

/**
 * Scan every image file in `source`, extract it, and reconcile document types.
 * `scanDirectory` in `@outtray/core/node` is this over a folder on disk.
 *
 * With `ocr` and `classify` both set, new documents are read and voted on
 * before extraction (ADR-0009 amendment 3): a confident vote on readable OCR
 * text routes the document to the typed prompt, a weak one is reconciled
 * against the generic extraction, and a page the OCR could not read takes
 * the extract-then-classify path below.
 *
 * Failure modes: rejects if the source cannot be listed or a file read, or if
 * the model provider rejects on a file (e.g. the runtime is unreachable).
 * Per-file extraction failures are captured as `result.valid === false`, not
 * thrown, so one unreadable document does not abort the batch's report shape.
 * An OCR failure on a file is recorded on its item (`ocr.error`) and the file
 * is extracted the old way; it never rejects the scan.
 * The classification stage never rejects: if the embedder or classifier fails,
 * items keep their single-stage VLM labels (`status: 'unclassified'`) and
 * `classifierError` records the reason. A failed typed re-extraction (provider
 * error, invalid output, or a type other than the target) leaves the item
 * `disputed` with its original extraction and review flag intact.
 */
export async function scanSource(
  provider: ModelProvider,
  source: DocumentSource,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const files = (await source.list()).sort();

  const scanned: string[] = [];
  const skipped: string[] = [];
  for (const name of files) {
    if (IMAGE_EXTENSIONS.has(extensionOf(name))) {
      scanned.push(name);
    } else {
      skipped.push(name);
    }
  }

  const model = options.model ? { model: options.model } : {};
  const extractFile = async (
    file: string,
    type?: DocumentType,
    bytes?: Uint8Array,
  ): Promise<ExtractResult> =>
    extract(provider, {
      images: [toBase64(bytes ?? (await source.read(file)))],
      ...(type ? { type } : {}),
      ...model,
    });

  let classifierError: string | null = null;
  let classifierPromise: Promise<TypeClassifier> | null = null;
  // Built at most once per scan, and only when something needs a vote.
  const getClassifier = (stage: ClassifyStageOptions): Promise<TypeClassifier> => {
    if (classifierPromise === null) {
      const given = stage.classifier;
      classifierPromise =
        given === undefined
          ? buildClassifier(stage.embedder)
          : typeof given === 'function'
            ? given()
            : Promise.resolve(given);
    }
    return classifierPromise;
  };

  // What the OCR read and how the classifier voted on it, by file (ADR-0009
  // amendment 3). Both stay empty without an OCR stage.
  const ocrOutcomes = new Map<string, OcrOutcome>();
  const votes = new Map<string, Classification>();
  const threshold = options.classify?.threshold ?? CONFIDENCE_THRESHOLD;
  // Items whose type the OCR vote already settled skip the classification
  // stage below; a routed item that fell back has had its one typed attempt
  // and skips the re-extraction.
  const voted = new Set<ScanItem>();
  const typedTried = new Set<ScanItem>();

  const extractPlanned = async (plan: Planned, bytes?: Uint8Array): Promise<ScanItem> => {
    const { file, contentHash, answer } = plan;
    if (answer && 'extractAs' in answer) {
      const result = await extractFile(file, answer.extractAs, bytes);
      const doc = result.document;
      return {
        file,
        contentHash,
        result,
        reconciliation: userVerdict(
          answer.extractAs,
          doc && doc.type === answer.extractAs ? doc.type : null,
        ),
        pinned: true,
      };
    }
    if (answer) return answer;
    const ocr = ocrOutcomes.get(file);
    const vote = votes.get(file) ?? null;
    let item: ScanItem | null = null;
    if (vote && vote.confidence >= threshold) {
      const result = await extractFile(file, vote.type, bytes);
      if (result.valid && result.document?.type === vote.type) {
        item = { file, contentHash, result, reconciliation: routedVerdict(vote) };
      }
    }
    if (item === null) {
      const result = await extractFile(file, undefined, bytes);
      item = {
        file,
        contentHash,
        result,
        reconciliation: reconcileType(result.document?.type ?? null, vote, threshold),
      };
      if (vote && vote.confidence >= threshold) typedTried.add(item);
    }
    if (ocr) item.ocr = ocr;
    if (vote) voted.add(item);
    return item;
  };

  // Without an OCR stage each file is read once and extracted at once, as
  // before. With one, every file is planned first so the OCR and the vote run
  // before any vision call; bytes are then read again rather than held, so a
  // large folder is never all in memory.
  const ocrStage = options.ocr && options.classify ? options.ocr : null;
  const planned: Planned[] = [];
  const items: ScanItem[] = [];
  for (const file of scanned) {
    const bytes = await source.read(file);
    const contentHash = await contentHashOf(bytes);
    const answer = options.reuse ? await options.reuse(file, contentHash) : null;
    if (ocrStage) planned.push({ file, contentHash, answer });
    else items.push(await extractPlanned({ file, contentHash, answer }, bytes));
  }

  if (ocrStage && options.classify) {
    const texts: Array<{ file: string; text: string }> = [];
    for (const { file, answer } of planned) {
      if (answer !== null) continue;
      try {
        const result = await ocrStage.recognize(file);
        const verdict = assessReadability(result);
        const reasons = [...new Set(verdict.pages.flatMap((p) => p.reasons))];
        ocrOutcomes.set(file, { readable: verdict.readable, reasons, error: null });
        if (verdict.readable) texts.push({ file, text: ocrPlainText(result) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ocrOutcomes.set(file, { readable: false, reasons: [], error: message });
      }
    }
    if (texts.length > 0) {
      const { embedder, k = CLASSIFIER_K } = options.classify;
      try {
        const classifier = await getClassifier(options.classify);
        const vectors = await embedder.embed(texts.map((t) => t.text));
        texts.forEach(({ file }, i) => {
          const vector = vectors[i];
          const vote = vector ? classifier.classify(vector, k) : null;
          if (vote) votes.set(file, vote);
        });
      } catch (error) {
        classifierError = error instanceof Error ? error.message : String(error);
      }
    }
    for (const plan of planned) items.push(await extractPlanned(plan));
  }

  if (options.classify) {
    const { embedder, k = CLASSIFIER_K } = options.classify;
    const classifiable = items.flatMap((item) => {
      // Reused items keep the verdict stored with them (ADR-0012), a pinned
      // type is the user's call, not the classifier's (#67), and an OCR vote
      // already settled the rest of the skipped ones.
      if (item.reused || item.pinned || voted.has(item)) return [];
      const doc = item.result.document;
      return doc ? [{ item, doc }] : [];
    });
    if (classifiable.length > 0) {
      try {
        const classifier = await getClassifier(options.classify);
        // Tokenized, the same text correction labels are embedded from (#67).
        const vectors = await embedder.embed(classifiable.map(({ doc }) => derivedText(doc)));
        classifiable.forEach(({ item, doc }, i) => {
          const vector = vectors[i];
          if (!vector) return;
          item.reconciliation = reconcileType(doc.type, classifier.classify(vector, k), threshold);
        });
      } catch (error) {
        classifierError = error instanceof Error ? error.message : String(error);
      }
    }

    // Third stage (accepted ADR-0009 amendment): one typed re-extraction per
    // disputed item, upgrading to `corrected` only when the result validates
    // as the classifier's type.
    for (const item of items) {
      if (item.reused || item.pinned || typedTried.has(item)) continue;
      if (item.reconciliation.status !== 'disputed') continue;
      const target = item.reconciliation.classification?.type;
      if (!target) continue;
      try {
        const retry = await extractFile(item.file, target);
        const upgraded = applyCorrection(item.reconciliation, retry);
        if (upgraded !== item.reconciliation) {
          item.result = retry;
          item.reconciliation = upgraded;
        }
      } catch {
        // Leave the item disputed; its review flag already routes it to a human.
      }
    }
  }

  return { scanned, skipped, items, classifierError };
}
