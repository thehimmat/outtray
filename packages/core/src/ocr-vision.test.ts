import { describe, expect, it } from 'vitest';
import {
  OCR_CONTRACT,
  OcrContractError,
  OcrError,
  type OcrResult,
  OcrUnavailableError,
} from './ocr-contract.js';
import { DEFAULT_OCR_BINARY, type OcrRunner, VisionOcr } from './ocr-vision.js';

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
