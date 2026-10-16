import { describe, expect, it } from 'vitest';
import {
  OCR_CONTRACT,
  OcrContractError,
  OcrError,
  type OcrResult,
  OcrUnavailableError,
} from './ocr-contract.js';
import { DEFAULT_OCR_BINARY, type OcrRunner, VisionOcr, visionRecognizer } from './ocr-vision.js';

const result: OcrResult = {
  contract: OCR_CONTRACT,
  engine: 'vision-recognize-text',
  engineRevision: 3,
  elapsedMs: 10,
  pages: [{ width: 2, height: 2, lines: [] }],
};

function runner(reply: Awaited<ReturnType<OcrRunner>>) {
  const calls: { binary: string; args: readonly string[] }[] = [];
  const run: OcrRunner = async (binary, args) => {
    calls.push({ binary, args });
    return reply;
  };
  return { run, calls };
}

describe('VisionOcr', () => {
  it('runs the sidecar on the path and returns the parsed result', async () => {
    const { run, calls } = runner({ status: 0, stdout: JSON.stringify(result), stderr: '' });
    const ocr = new VisionOcr({ binary: '/opt/outtray-ocr', run, platform: 'darwin' });
    await expect(ocr.recognize('/docs/bill.png')).resolves.toEqual(result);
    expect(calls).toEqual([{ binary: '/opt/outtray-ocr', args: ['/docs/bill.png'] }]);
  });

  it('passes --no-language-correction when language correction is off', async () => {
    const { run, calls } = runner({ status: 0, stdout: JSON.stringify(result), stderr: '' });
    await new VisionOcr({ run, platform: 'darwin', languageCorrection: false }).recognize('a.png');
    expect(calls[0]?.args).toEqual(['--no-language-correction', 'a.png']);
  });

  it('passes --enhance when preprocessing is on, before the path', async () => {
    const { run, calls } = runner({ status: 0, stdout: JSON.stringify(result), stderr: '' });
    await new VisionOcr({ run, platform: 'darwin', enhance: true }).recognize('a.png');
    expect(calls[0]?.args).toEqual(['--enhance', 'a.png']);
  });

  it('defaults to the binary on PATH', async () => {
    const { run, calls } = runner({ status: 0, stdout: JSON.stringify(result), stderr: '' });
    await new VisionOcr({ run, platform: 'darwin' }).recognize('a.png');
    expect(calls[0]?.binary).toBe(DEFAULT_OCR_BINARY);
  });

  it('refuses off macOS without running anything, since Vision is macOS-only', async () => {
    const { run, calls } = runner({ status: 0, stdout: '', stderr: '' });
    const ocr = new VisionOcr({ run, platform: 'linux' });
    await expect(ocr.recognize('a.png')).rejects.toThrow(OcrUnavailableError);
    expect(calls).toEqual([]);
  });

  it('reports a missing sidecar as unavailable, with how to build it', async () => {
    const { run } = runner({
      status: -1,
      stdout: '',
      stderr: 'spawn outtray-ocr ENOENT',
      notFound: true,
    });
    const ocr = new VisionOcr({ run, platform: 'darwin' });
    await expect(ocr.recognize('a.png')).rejects.toThrow(OcrUnavailableError);
    await expect(ocr.recognize('a.png')).rejects.toThrow(/packages\/ocr-vision/);
  });

  it('reports a failed run with its exit status and stderr', async () => {
    const { run } = runner({ status: 65, stdout: '', stderr: 'cannot read image: a.png\n' });
    const ocr = new VisionOcr({ run, platform: 'darwin' });
    await expect(ocr.recognize('a.png')).rejects.toThrow(OcrError);
    await expect(ocr.recognize('a.png')).rejects.toThrow(/exit 65.*cannot read image/);
  });

  it('passes a contract mismatch through as a contract error', async () => {
    const { run } = runner({ status: 0, stdout: '{"contract":"ocr-v9"}', stderr: '' });
    const ocr = new VisionOcr({ run, platform: 'darwin' });
    await expect(ocr.recognize('a.png')).rejects.toThrow(OcrContractError);
  });
});

describe('VisionOcr as a scan recognizer (ADR-0009 amendment 3)', () => {
  it('names its contract and flags in its key', () => {
    const run: OcrRunner = async () => ({ status: 0, stdout: '', stderr: '' });
    expect(new VisionOcr({ run }).key).toBe(`${OCR_CONTRACT}:vision`);
    expect(new VisionOcr({ run, languageCorrection: false, enhance: true }).key).toBe(
      `${OCR_CONTRACT}:vision:no-language-correction:enhance`,
    );
  });

  it('probes the sidecar with --contract and accepts a matching version', async () => {
    const { run, calls } = runner({ status: 0, stdout: `${OCR_CONTRACT}\n`, stderr: '' });
    await expect(new VisionOcr({ run, platform: 'darwin' }).probe()).resolves.toBeUndefined();
    expect(calls[0]?.args).toEqual(['--contract']);
  });

  it('fails the probe off macOS, when the binary is missing, or on another contract', async () => {
    const ok = runner({ status: 0, stdout: OCR_CONTRACT, stderr: '' });
    await expect(new VisionOcr({ run: ok.run, platform: 'linux' }).probe()).rejects.toThrow(
      OcrUnavailableError,
    );
    expect(ok.calls).toEqual([]);
    const missing = runner({ status: -1, stdout: '', stderr: 'ENOENT', notFound: true });
    await expect(new VisionOcr({ run: missing.run, platform: 'darwin' }).probe()).rejects.toThrow(
      OcrUnavailableError,
    );
    const stale = runner({ status: 0, stdout: 'ocr-v0', stderr: '' });
    await expect(new VisionOcr({ run: stale.run, platform: 'darwin' }).probe()).rejects.toThrow(
      /speaks "ocr-v0"/,
    );
  });

  it('recognizes a listed file inside its folder', async () => {
    const { run, calls } = runner({ status: 0, stdout: JSON.stringify(result), stderr: '' });
    const recognizer = visionRecognizer('/pile', new VisionOcr({ run, platform: 'darwin' }));
    expect(recognizer.key).toBe(`${OCR_CONTRACT}:vision`);
    await expect(recognizer.recognize('bill.png')).resolves.toEqual(result);
    expect(calls[0]?.args).toEqual(['/pile/bill.png']);
  });
});
