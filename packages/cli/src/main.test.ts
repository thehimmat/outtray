import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ActionQueue,
  contentHashOf,
  type FindResult,
  IDENTIFIER_STORAGE_DISCLOSURE,
  MemoryStorage,
  readSettings,
  redactExtraction,
  type ScanItem,
  type ScanReport,
  writeSettings,
} from '@outtray/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findInFolder,
  formatActions,
  formatCitations,
  formatReport,
  run,
  runCorrect,
  runReveal,
  runSettings,
  scanFolder,
} from './main.js';

function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}
function captureStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run (arg handling)', () => {
  it('prints usage and exits 0 for --help and no args', async () => {
    const out = captureStdout();
    expect(await run(['--help'])).toBe(0);
    expect(await run([])).toBe(0);
    expect(out.mock.calls.join('')).toContain('Usage:');
  });

  it('prints the version and exits 0', async () => {
    const out = captureStdout();
    expect(await run(['--version'])).toBe(0);
    expect(out.mock.calls.join('')).toContain('0.0.0');
  });

  it('exits 1 on an unknown command', async () => {
    captureStdout();
    const err = captureStderr();
    expect(await run(['frobnicate'])).toBe(1);
    expect(err.mock.calls.join('')).toContain('Unknown command');
  });

  it('exits 1 when scan is given no directory (without touching the network)', async () => {
    const err = captureStderr();
    expect(await run(['scan'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/needs a directory/);
  });

  it('exits 1 when the scan directory does not exist', async () => {
    const err = captureStderr();
    expect(await run(['scan', '/no/such/outtray/dir'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/Cannot read directory/);
  });

  it('exits 1 when actions is given no directory or a missing one (no network)', async () => {
    const err = captureStderr();
    expect(await run(['actions'])).toBe(1);
    expect(await run(['actions', '/no/such/outtray/dir'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/needs a directory/);
    expect(err.mock.calls.join('')).toMatch(/Cannot read directory/);
  });

  it('exits 1 when find is missing a directory or query (no network)', async () => {
    const err = captureStderr();
    expect(await run(['find'])).toBe(1);
    expect(await run(['find', '/some/dir'])).toBe(1); // dir but no query
    expect(err.mock.calls.join('')).toMatch(/usage: outtray find/);
  });

  it('exits 1 when the find directory does not exist', async () => {
    const err = captureStderr();
    expect(await run(['find', '/no/such/outtray/dir', 'butter'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/Cannot read directory/);
  });
});

describe('formatReport', () => {
  const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };

  const billDoc = {
    type: 'bill' as const,
    summary: 'DMV renewal, $301 due Aug 31.',
    action_items: [{ text: 'Pay $301.00', due_date: '2026-08-31' }],
    payee: 'State DMV',
    amount_due: '$301.00',
    due_date: '2026-08-31',
    late_fee: '$54.00',
  };

  function billItem(reconciliation: ScanItem['reconciliation']): ScanItem {
    return {
      file: 'renewal.png',
      contentHash: 'hash-renewal',
      result: {
        valid: true,
        jsonChannel: 'thinking',
        raw: {},
        usage,
        error: null,
        document: billDoc,
      },
      reconciliation,
    };
  }

  const unclassified: ScanItem['reconciliation'] = {
    effectiveType: 'bill',
    status: 'unclassified',
    review: false,
    vlmType: 'bill',
    classification: null,
  };

  it('renders type, summary, actions, and the skipped list', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: ['notes.txt'],
      items: [billItem(unclassified)],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill]');
    expect(text).toContain('DMV renewal');
    expect(text).toContain('- Pay $301.00 (due 2026-08-31)');
    expect(text).toContain('Skipped: notes.txt');
    expect(text).not.toContain('Review:');
  });

  it('redacts identifiers in the summary and action items', () => {
    const passport = {
      type: 'id_document' as const,
      summary: 'Passport AB1234567 for Jane Doe.',
      action_items: [{ text: 'Renew AB 123 4567', due_date: '2027-01-01' }],
      holder_name: 'Jane Doe',
      id_number: 'AB1234567',
      issuer: 'US Department of State',
      expiry_date: '2027-03-01',
    };
    const item = billItem(unclassified);
    const report: ScanReport = {
      scanned: ['passport.png'],
      skipped: [],
      items: [{ ...item, result: { ...item.result, document: passport } }],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('Passport [id_number ending 4567, 9 chars] for Jane Doe.');
    expect(text).toContain('- Renew [id_number ending 4567, 9 chars] (due 2027-01-01)');
    expect(text).not.toMatch(/AB ?123/);
  });

  it('renders a confirmed type with its confidence and the review tally', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: [],
      items: [
        billItem({
          effectiveType: 'bill',
          status: 'confirmed',
          review: false,
          vlmType: 'bill',
          classification: { type: 'bill', confidence: 0.69, votes: { bill: 1.2 } },
        }),
      ],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill, confirmed 0.69]');
    expect(text).toContain('Review: 0 of 1 item(s) flagged.');
  });

  it('renders a corrected type with its provenance', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: [],
      items: [
        billItem({
          effectiveType: 'bill',
          status: 'corrected',
          review: false,
          vlmType: 'statement',
          classification: { type: 'bill', confidence: 0.68, votes: { bill: 1.3 } },
        }),
      ],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill, corrected from statement 0.68]');
    expect(text).toContain('Review: 0 of 1 item(s) flagged.');
  });

  it('renders a disputed type as needing review', () => {
    const report: ScanReport = {
      scanned: ['stmt.png'],
      skipped: [],
      items: [
        {
          ...billItem({
            effectiveType: 'statement',
            status: 'disputed',
            review: true,
            vlmType: 'statement',
            classification: { type: 'bill', confidence: 0.68, votes: { bill: 1.3 } },
          }),
          file: 'stmt.png',
          result: {
            valid: true,
            jsonChannel: 'thinking',
            raw: {},
            usage,
            error: null,
            document: {
              type: 'statement',
              summary: 'Looks like a statement.',
              action_items: [],
              institution: 'Metro Power',
              account_number: '123',
              period_start: null,
              period_end: null,
              balance: null,
            },
          },
        },
      ],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain('stmt.png  [statement, classifier says bill 0.68, needs review]');
    expect(text).toContain('Review: 1 of 1 item(s) flagged.');
  });

  it('renders a low-confidence disagreement as unknown', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: [],
      items: [
        billItem({
          effectiveType: 'unknown',
          status: 'low_confidence',
          review: true,
          vlmType: 'bill',
          classification: { type: 'statement', confidence: 0.53, votes: { statement: 0.7 } },
        }),
      ],
      classifierError: null,
    };
    const text = formatReport('pile', report);
    expect(text).toContain(
      'renewal.png  [unknown, type unclear (vlm bill vs classifier statement 0.53), needs review]',
    );
  });

  it('notes classifier degradation instead of a review tally', () => {
    const report: ScanReport = {
      scanned: ['renewal.png'],
      skipped: [],
      items: [billItem(unclassified)],
      classifierError: 'embedder unreachable',
    };
    const text = formatReport('pile', report);
    expect(text).toContain('renewal.png  [bill]');
    expect(text).toContain(
      'Classifier unavailable (embedder unreachable); types are single-stage VLM labels.',
    );
    expect(text).not.toContain('Review:');
  });

  it('renders a failed extraction without throwing', () => {
    const report: ScanReport = {
      scanned: ['x.png'],
      skipped: [],
      items: [
        {
          file: 'x.png',
          contentHash: 'hash-x',
          result: {
            valid: false,
            jsonChannel: null,
            raw: null,
            usage,
            error: 'no JSON',
            document: null,
          },
          reconciliation: {
            effectiveType: 'unknown',
            status: 'unclassified',
            review: true,
            vlmType: null,
            classification: null,
          },
        },
      ],
      classifierError: null,
    };
    expect(formatReport('pile', report)).toContain('could not extract: no JSON');
  });
});

describe('scanFolder (incremental, ADR-0012)', () => {
  const passport = {
    type: 'id_document',
    summary: 'Passport AB1234567 for a dentist.',
    action_items: [],
    holder_name: 'Jane Doe',
    id_number: 'AB1234567',
    issuer: 'US Department of State',
    expiry_date: '2027-03-01',
  };
  const bill = {
    type: 'bill',
    summary: 'Butter delivery invoice.',
    action_items: [],
    payee: 'Dairy Co',
    amount_due: '$12.00',
    due_date: '2026-11-01',
    late_fee: null,
  };

  /** Answers by file content: bytes 'P...' are the passport, anything else the bill. */
  function fakeModels() {
    const provider = {
      name: 'fake',
      calls: 0,
      async generate(req: { images?: string[] }) {
        provider.calls += 1;
        const bytes = Buffer.from(req.images?.[0] ?? '', 'base64').toString();
        return {
          json: bytes.startsWith('P') ? passport : bill,
          jsonChannel: 'content' as const,
          content: '',
          thinking: '',
          doneReason: 'stop',
          usage: { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 },
        };
      },
    };
    const embedder = {
      name: 'letters',
      calls: 0,
      fail: false,
      async embed(texts: string[]) {
        embedder.calls += 1;
        if (embedder.fail) throw new Error('embedder down');
        return texts.map((t) =>
          [...'abdeprt'].map((c) => t.toLowerCase().split(c).length - 1 + 0.01),
        );
      },
    };
    return { provider, embedder };
  }

  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(options: { config?: string; databaseExists?: boolean } = {}) {
    dir = await mkdtemp(join(tmpdir(), 'outtray-cli-'));
    const pile = join(dir, 'pile');
    await mkdir(pile);
    await writeFile(join(pile, 'passport.png'), 'P-bytes');
    await writeFile(join(pile, 'bill.png'), 'B-bytes');
    const configPath = join(dir, 'outtray', 'config.json');
    if (options.config !== undefined) {
      await writeSettings(configPath, { identifierStorage: false });
      await writeFile(configPath, options.config);
    }
    const store = new MemoryStorage();
    // Callers close what scanFolder opened; keep this store readable for assertions.
    vi.spyOn(store, 'close').mockResolvedValue();
    const deps = {
      configPath,
      databasePath: join(dir, 'outtray', 'outtray.db'),
      databaseExists: async () => options.databaseExists ?? true,
      openStorage: async () => store,
    };
    return { pile, store, deps, models: fakeModels() };
  }

  it('first scan extracts and indexes everything; a repeat makes no model calls', async () => {
    const { pile, store, deps, models } = await setup();
    const first = await scanFolder(pile, models, deps);
    expect(models.provider.calls).toBe(2);
    expect(first.notes).toBe(
      'Saved 2 document(s) to the encrypted store. ID numbers: last four only (identifier storage is off).\n',
    );
    expect((await store.listDocuments()).every((d) => d.indexKey !== null)).toBe(true);
    expect((await store.listChunks()).length).toBeGreaterThan(0);

    models.provider.calls = 0;
    models.embedder.calls = 0;
    const again = await scanFolder(pile, models, deps);
    expect(models.provider.calls).toBe(0);
    expect(models.embedder.calls).toBe(0);
    expect(again.report.items.every((i) => i.reused)).toBe(true);
    expect(again.notes).toMatch(
      /Saved 2 document\(s\) to the encrypted store \(2 unchanged since the last scan\)/,
    );
  });

  it('re-extracts only a file whose bytes changed', async () => {
    const { pile, deps, models } = await setup();
    await scanFolder(pile, models, deps);
    await writeFile(join(pile, 'bill.png'), 'B-bytes, edited');
    models.provider.calls = 0;
    const again = await scanFolder(pile, models, deps);
    expect(models.provider.calls).toBe(1);
    expect(again.report.items.map((i) => [i.file, i.reused ?? false])).toEqual([
      ['bill.png', false],
      ['passport.png', true],
    ]);
  });

  it('with identifier storage switched on, re-extracts documents whose number is not vaulted', async () => {
    const { pile, store, deps, models } = await setup();
    await scanFolder(pile, models, deps);
    await writeSettings(deps.configPath, { identifierStorage: true });
    models.provider.calls = 0;
    const again = await scanFolder(pile, models, deps);
    expect(models.provider.calls).toBe(1);
    expect(again.notes).toMatch(/1 stored in full/);
    const passportHash = again.report.items.find((i) => i.file === 'passport.png')?.contentHash;
    expect(await store.getIdentifier(passportHash ?? '', 'id_number')).toBe('AB1234567');
  });

  it('never prints or stores a reused extraction re-redacted', async () => {
    const { pile, store, deps, models } = await setup();
    await scanFolder(pile, models, deps);
    const again = await scanFolder(pile, models, deps);
    const text = formatReport(pile, again.report);
    expect(text).toContain('[id_number ending 4567, 9 chars]');
    expect(JSON.stringify(await store.listDocuments())).not.toMatch(/ending [A-Z]{4}, 2\d chars/);
  });

  it('saves but does not index when the embedder fails, and re-reads those next time', async () => {
    const { pile, store, deps, models } = await setup();
    models.embedder.fail = true;
    const first = await scanFolder(pile, models, deps);
    expect(first.notes).toMatch(/Search index not updated \(embedder down\)/);
    expect((await store.listDocuments()).every((d) => d.indexKey === null)).toBe(true);

    models.embedder.fail = false;
    models.provider.calls = 0;
    await scanFolder(pile, models, deps);
    expect(models.provider.calls).toBe(2);
  });

  it('passes on a settings warning rather than hiding why the setting is off', async () => {
    const { pile, deps, models } = await setup({ config: 'not json' });
    const { notes } = await scanFolder(pile, models, deps);
    expect(notes).toMatch(/not valid JSON; using defaults\.\n/);
    expect(notes).toMatch(/identifier storage is off/);
  });

  it('scans without the store when it cannot be opened, and says so', async () => {
    const { pile, deps, models } = await setup();
    const result = await scanFolder(pile, models, {
      ...deps,
      openStorage: async () => {
        throw new Error('Keychain locked');
      },
    });
    expect(result.storage).toBeNull();
    expect(result.report.items).toHaveLength(2);
    expect(result.notes).toBe('Not saved to the encrypted store: Keychain locked\n');
  });

  it('explains a damaged store in recoverable terms instead of a SQLite string', async () => {
    const { pile, deps, models } = await setup();
    const result = await scanFolder(pile, models, {
      ...deps,
      openStorage: async () => {
        throw Object.assign(new Error('database disk image is malformed'), {
          code: 'SQLITE_CORRUPT',
        });
      },
    });
    expect(result.notes).toMatch(/outtray\.db is damaged .*delete it and re-scan/);
  });

  it('scans without the store when store paths are unavailable (not macOS)', async () => {
    const { pile, models } = await setup();
    const result = await scanFolder(pile, models, () => {
      throw new Error('this is linux');
    });
    expect(result.storage).toBeNull();
    expect(result.notes).toBe('Not saved to the encrypted store: this is linux\n');
  });

  it('closes the store and rethrows when the scan itself fails', async () => {
    const { pile, store, deps, models } = await setup();
    models.provider.generate = async () => {
      throw new Error('ollama unreachable');
    };
    await expect(scanFolder(pile, models, deps)).rejects.toThrow('ollama unreachable');
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it('after outtray correct, the next scan re-reads the file under the pinned type and keeps the pin', async () => {
    const { pile, store, deps, models } = await setup();
    await scanFolder(pile, models, deps);
    const err = captureStderr();
    const out = captureStdout();
    expect(await runCorrect([join(pile, 'bill.png'), 'statement'], deps)).toBe(0);
    expect(out.mock.calls.join('')).toMatch(/bill\.png is now marked statement/);
    expect(err.mock.calls.join('')).toBe('');

    models.provider.calls = 0;
    const again = await scanFolder(pile, models, deps);
    expect(models.provider.calls).toBe(1);
    const bill = again.report.items.find((i) => i.file === 'bill.png');
    expect(bill?.pinned).toBe(true);
    expect(bill?.reconciliation).toMatchObject({ status: 'user', effectiveType: 'statement' });
    const storedBill = (await store.listDocuments()).find((d) => d.path.endsWith('bill.png'));
    expect(storedBill?.userType).toBe('statement');
    // Embedded lazily: nothing new needed classifying yet.
    expect(await store.listLabels()).toMatchObject([
      { type: 'statement', provenance: 'correction', embedModel: null },
    ]);

    await writeFile(join(pile, 'another.png'), 'B-other');
    await scanFolder(pile, models, deps);
    expect(await store.listLabels()).toMatchObject([
      { type: 'statement', provenance: 'correction', embedModel: 'nomic-embed-text' },
    ]);
  });

  it('shows the first-run notice when this scan created the store', async () => {
    const { pile, deps, models } = await setup({ databaseExists: false });
    const { notes } = await scanFolder(pile, models, deps);
    expect(notes).toMatch(/^Outtray keeps an encrypted copy of what it reads at /);
    expect(notes).toMatch(/Saved 2 document\(s\)/);
  });

  it('shows no first-run notice when the store could not be created', async () => {
    const { pile, deps, models } = await setup({ databaseExists: false });
    const { notes } = await scanFolder(pile, models, {
      ...deps,
      openStorage: async () => {
        throw new Error('not macOS');
      },
    });
    expect(notes).toBe('Not saved to the encrypted store: not macOS\n');
  });
});

describe('findInFolder', () => {
  it('answers from the store, and a repeat query loads no vision model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outtray-cli-find-'));
    try {
      const pile = join(dir, 'pile');
      await mkdir(pile);
      await writeFile(join(pile, 'bill.png'), 'B-bytes');
      const store = new MemoryStorage();
      vi.spyOn(store, 'close').mockResolvedValue();
      const deps = {
        configPath: join(dir, 'config.json'),
        databasePath: join(dir, 'outtray.db'),
        databaseExists: async () => true,
        openStorage: async () => store,
      };
      let generateCalls = 0;
      const provider = {
        name: 'fake',
        async generate() {
          generateCalls += 1;
          return {
            json: {
              type: 'bill',
              summary: 'Butter delivery invoice.',
              action_items: [],
              payee: 'Dairy Co',
              amount_due: '$12.00',
              due_date: null,
              late_fee: null,
            },
            jsonChannel: 'content' as const,
            content: '',
            thinking: '',
            doneReason: 'stop',
            usage: { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 },
          };
        },
      };
      const embedder = {
        name: 'letters',
        async embed(texts: string[]) {
          return texts.map((t) => [...'abdeprt'].map((c) => t.split(c).length - 1 + 0.01));
        },
      };
      const first = await findInFolder(pile, 'butter', { provider, embedder }, deps);
      expect(first.result.citations[0]?.source.documentId).toBe('bill.png');
      expect(first.notes).toMatch(/Saved 1 document/);
      generateCalls = 0;
      const again = await findInFolder(pile, 'butter', { provider, embedder }, deps);
      expect(generateCalls).toBe(0);
      expect(again.result.citations[0]?.source.documentId).toBe('bill.png');
      expect(store.close).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to an in-memory index when the store is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outtray-cli-find-'));
    try {
      await writeFile(join(dir, 'bill.png'), 'B-bytes');
      const provider = {
        name: 'fake',
        async generate() {
          return {
            json: {
              type: 'bill',
              summary: 'Butter delivery invoice.',
              action_items: [],
              payee: 'Dairy Co',
              amount_due: '$12.00',
              due_date: null,
              late_fee: null,
            },
            jsonChannel: 'content' as const,
            content: '',
            thinking: '',
            doneReason: 'stop',
            usage: { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 },
          };
        },
      };
      const embedder = {
        name: 'letters',
        async embed(texts: string[]) {
          return texts.map((t) => [...'abdeprt'].map((c) => t.split(c).length - 1 + 0.01));
        },
      };
      const { result, notes } = await findInFolder(dir, 'butter', { provider, embedder }, () => {
        throw new Error('this is linux');
      });
      expect(result.citations[0]?.source.documentId).toBe('bill.png');
      expect(notes).toMatch(/Not saved to the encrypted store: this is linux/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('formatActions', () => {
  const queue: ActionQueue = {
    items: [
      {
        id: 'flag-disputed:stmt.png',
        kind: 'attention_flag',
        ruleId: 'flag-disputed',
        title: 'Type disputed for stmt.png: extractor says statement, classifier says bill',
        date: null,
        advice: null,
        needsReviewFirst: true,
        citations: [{ documentId: 'stmt.png', snippet: 'type: statement' }],
        status: 'proposed',
      },
      {
        id: 'todo-extracted:renewal.png',
        kind: 'todo',
        ruleId: 'todo-extracted',
        title: 'Pay $301.00',
        date: '2026-08-31',
        advice: null,
        needsReviewFirst: false,
        citations: [{ documentId: 'renewal.png', snippet: 'Pay $301.00' }],
        status: 'proposed',
      },
      {
        id: 'ret-bill:renewal.png',
        kind: 'retention_advice',
        ruleId: 'ret-bill',
        title: 'Shred once payment has cleared; keep about a year if tax-relevant.',
        date: null,
        advice: 'shred',
        needsReviewFirst: false,
        citations: [{ documentId: 'renewal.png', snippet: 'type: bill' }],
        status: 'proposed',
      },
    ],
    flagged: 1,
    needsReview: 1,
    disclaimer: 'Not legal advice.',
  };

  it('renders sections, citations, review markers, counts, and the disclaimer', () => {
    const text = formatActions('pile', queue);
    expect(text).toContain('Proposed actions for pile: 3 item(s).');
    expect(text).toContain('1 item(s) flagged for attention, 1 not yet reviewed by you.');
    expect(text).toContain('Attention:');
    expect(text).toContain('[review first]');
    expect(text).toContain('To do:');
    expect(text).toContain('- Pay $301.00 (2026-08-31)');
    expect(text).toContain('source: renewal.png: "Pay $301.00"');
    expect(text).toContain('Retention advice:');
    expect(text).toContain('- shred: Shred once payment has cleared');
    expect(text).toContain('Not legal advice.');
  });

  it('never renders an all-clear for an empty queue', () => {
    const empty: ActionQueue = { items: [], flagged: 0, needsReview: 0, disclaimer: 'D.' };
    const text = formatActions('pile', empty);
    expect(text).toContain('0 item(s) flagged for attention');
    expect(text).toContain('Nothing to propose');
    expect(text).not.toMatch(/all clear/i);
  });
});

describe('formatCitations', () => {
  it('renders ranked citations with scores and sources', () => {
    const result: FindResult = {
      scanned: { scanned: ['a.png', 'b.png'], skipped: [], items: [], classifierError: null },
      citations: [
        {
          text: 'Metro Electric bill, $91 due Feb 16.',
          score: 0.94,
          source: { documentId: 'a.png', page: undefined, chunkIndex: 0 },
        },
        {
          text: 'Grocery receipt with butter.',
          score: 0.71,
          source: { documentId: 'b.png', page: 2, chunkIndex: 1 },
        },
      ],
    };
    const text = formatCitations('metro electric', result);
    expect(text).toContain('Query: metro electric');
    expect(text).toContain('Scanned 2 document(s).');
    expect(text).toContain('1. [0.94] a.png');
    expect(text).toContain('2. [0.71] b.png p2');
  });

  it('says so when nothing is relevant', () => {
    const result: FindResult = {
      scanned: { scanned: [], skipped: [], items: [], classifierError: null },
      citations: [],
    };
    expect(formatCitations('x', result)).toContain('No relevant passages found.');
  });
});

/** A temp data dir with a real config file and an in-memory store. */
async function vaultFixture(options: { databaseExists?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'outtray-cli-vault-'));
  const store = new MemoryStorage();
  vi.spyOn(store, 'close').mockResolvedValue();
  const passportFile = join(dir, 'passport.png');
  await writeFile(passportFile, 'passport bytes');
  const passport = {
    type: 'id_document' as const,
    summary: 'Passport.',
    action_items: [],
    holder_name: 'Jane Doe',
    id_number: 'AB1234567',
    issuer: 'US Department of State',
    expiry_date: '2027-03-01',
  };
  const hash = contentHashOf(Buffer.from('passport bytes'));
  await store.putDocument({
    contentHash: hash,
    path: passportFile,
    type: 'id_document',
    extraction: redactExtraction(passport),
    reconciliation: null,
    scannedAt: 1,
    extractorKey: null,
    indexKey: null,
    userType: null,
  });
  return {
    dir,
    store,
    hash,
    passportFile,
    deps: {
      configPath: join(dir, 'outtray', 'config.json'),
      databasePath: join(dir, 'outtray', 'outtray.db'),
      databaseExists: async () => options.databaseExists ?? true,
      openStorage: async () => store,
      stdoutIsTerminal: true,
    },
  };
}

describe('outtray reveal', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('prints only the full value on stdout, and nothing about it on stderr', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    await f.store.putIdentifiers(f.hash, [{ field: 'id_number', value: 'AB1234567' }]);
    const out = captureStdout();
    const err = captureStderr();
    expect(await runReveal([f.passportFile, 'id_number'], f.deps)).toBe(0);
    expect(out.mock.calls.join('')).toBe('AB1234567\n');
    expect(err.mock.calls.join('')).not.toContain('AB1234567');
    expect(err.mock.calls.join('')).not.toContain('4567');
  });

  it('closes the store after revealing', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    captureStdout();
    await runReveal([f.passportFile, 'id_number'], f.deps);
    expect(f.store.close).toHaveBeenCalledTimes(1);
  });

  it('with the setting off, explains that only the last four are kept', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const out = captureStdout();
    const err = captureStderr();
    expect(await runReveal([f.passportFile, 'id_number'], f.deps)).toBe(1);
    expect(out.mock.calls.join('')).toBe('');
    const message = err.mock.calls.join('');
    expect(message).toMatch(/identifier storage is off/);
    expect(message).toContain('[id_number ending 4567, 9 chars]');
    expect(message).toMatch(/outtray settings/);
  });

  it('with the setting on but nothing vaulted yet, says to re-scan', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    await writeSettings(f.deps.configPath, { identifierStorage: true });
    const err = captureStderr();
    captureStdout();
    expect(await runReveal([f.passportFile, 'id_number'], f.deps)).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/next scan/);
  });

  it('names the field the document does carry when asked for another', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const err = captureStderr();
    expect(await runReveal([f.passportFile, 'policy_number'], f.deps)).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/carries id_number, not policy_number/);
  });

  it('rejects a field that is not an identifier field, before opening the store', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const open = vi.fn(f.deps.openStorage);
    const err = captureStderr();
    expect(await runReveal([f.passportFile, 'holder_name'], { ...f.deps, openStorage: open })).toBe(
      1,
    );
    expect(err.mock.calls.join('')).toMatch(/id_number, policy_number, account_number/);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not create a store just to say nothing is there', async () => {
    const f = await vaultFixture({ databaseExists: false });
    dir = f.dir;
    const open = vi.fn(f.deps.openStorage);
    const err = captureStderr();
    expect(await runReveal([f.passportFile, 'id_number'], { ...f.deps, openStorage: open })).toBe(
      1,
    );
    expect(err.mock.calls.join('')).toMatch(/outtray scan/);
    expect(open).not.toHaveBeenCalled();
  });

  it('reports a file that was never scanned', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const other = join(f.dir, 'other.png');
    await writeFile(other, 'other bytes');
    const err = captureStderr();
    expect(await runReveal([other, 'id_number'], f.deps)).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/No scanned document matches/);
  });

  it('refuses to write the value into a pipe or file unless --to-pipe says so (#101)', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    await f.store.putIdentifiers(f.hash, [{ field: 'id_number', value: 'AB1234567' }]);
    const out = captureStdout();
    const err = captureStderr();
    const piped = { ...f.deps, stdoutIsTerminal: false };
    const open = vi.fn(piped.openStorage);
    expect(await runReveal([f.passportFile, 'id_number'], { ...piped, openStorage: open })).toBe(1);
    expect(out.mock.calls.join('')).toBe('');
    expect(err.mock.calls.join('')).toMatch(/--to-pipe/);
    expect(open).not.toHaveBeenCalled();

    expect(await runReveal([f.passportFile, 'id_number', '--to-pipe'], piped)).toBe(0);
    expect(out.mock.calls.join('')).toBe('AB1234567\n');
  });

  it('accepts --to-pipe anywhere in the arguments', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    await f.store.putIdentifiers(f.hash, [{ field: 'id_number', value: 'AB1234567' }]);
    const out = captureStdout();
    const piped = { ...f.deps, stdoutIsTerminal: false };
    expect(await runReveal(['--to-pipe', f.passportFile, 'id_number'], piped)).toBe(0);
    expect(out.mock.calls.join('')).toBe('AB1234567\n');
  });

  it('prints usage when arguments are missing', async () => {
    const err = captureStderr();
    expect(await run(['reveal'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/usage: outtray reveal <file> <field>/);
  });
});

describe('outtray correct', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('pins the type and says the next scan re-reads it when the extraction is of another type', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const out = captureStdout();
    expect(await runCorrect([f.passportFile, 'statement'], f.deps)).toBe(0);
    expect(out.mock.calls.join('')).toMatch(
      /passport\.png is now marked statement\. The next scan reads it again as statement\./,
    );
    expect(await f.store.getDocument(f.hash)).toMatchObject({ userType: 'statement' });
    expect(f.store.close).toHaveBeenCalledTimes(1);
  });

  it('confirms without a re-read when the type already matches', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const out = captureStdout();
    expect(await runCorrect([f.passportFile, 'id_document'], f.deps)).toBe(0);
    expect(out.mock.calls.join('')).toMatch(/passport\.png is now marked id_document\.\n/);
    expect(out.mock.calls.join('')).not.toMatch(/next scan/);
  });

  it('rejects a type that is not a document type, or unknown, before opening the store', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const open = vi.fn(f.deps.openStorage);
    const err = captureStderr();
    expect(await runCorrect([f.passportFile, 'invoice'], { ...f.deps, openStorage: open })).toBe(1);
    expect(await runCorrect([f.passportFile, 'unknown'], { ...f.deps, openStorage: open })).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/letter, bill, receipt, id_document, contract/);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not create a store, and reports a file never scanned', async () => {
    const f = await vaultFixture({ databaseExists: false });
    dir = f.dir;
    const err = captureStderr();
    expect(await runCorrect([f.passportFile, 'bill'], f.deps)).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/outtray scan/);

    const g = await vaultFixture();
    const other = join(g.dir, 'other.png');
    await writeFile(other, 'other bytes');
    expect(await runCorrect([other, 'bill'], g.deps)).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/No scanned document matches/);
    await rm(g.dir, { recursive: true, force: true });
  });

  it('prints usage when arguments are missing', async () => {
    const err = captureStderr();
    expect(await run(['correct'])).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/usage: outtray correct <file> <type>/);
  });
});

describe('outtray settings', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const never = async () => {
    throw new Error('should not prompt');
  };

  it('shows the current setting and the disclosure', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const out = captureStdout();
    expect(await runSettings([], { ...f.deps, interactive: false, confirm: never })).toBe(0);
    const text = out.mock.calls.join('');
    expect(text).toMatch(/^identifier-storage: off\n/);
    expect(text).toContain(IDENTIFIER_STORAGE_DISCLOSURE);
  });

  it('turning on shows the disclosure, asks, and records the choice on yes', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const out = captureStdout();
    const confirm = vi.fn(async () => true);
    expect(
      await runSettings(['identifier-storage', 'on'], { ...f.deps, interactive: true, confirm }),
    ).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(out.mock.calls.join('')).toContain(IDENTIFIER_STORAGE_DISCLOSURE);
    expect(out.mock.calls.join('')).toMatch(/next scan/);
    expect((await readSettings(f.deps.configPath)).settings.identifierStorage).toBe(true);
  });

  it('turning on and answering no changes nothing', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const out = captureStdout();
    expect(
      await runSettings(['identifier-storage', 'on'], {
        ...f.deps,
        interactive: true,
        confirm: async () => false,
      }),
    ).toBe(0);
    expect(out.mock.calls.join('')).toMatch(/Not changed/);
    expect((await readSettings(f.deps.configPath)).settings.identifierStorage).toBe(false);
  });

  it('turning on without a terminal needs --yes rather than defaulting to yes', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    captureStdout();
    const err = captureStderr();
    const deps = { ...f.deps, interactive: false, confirm: never };
    expect(await runSettings(['identifier-storage', 'on'], deps)).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/--yes/);
    expect((await readSettings(f.deps.configPath)).settings.identifierStorage).toBe(false);

    expect(await runSettings(['identifier-storage', 'on', '--yes'], deps)).toBe(0);
    expect((await readSettings(f.deps.configPath)).settings.identifierStorage).toBe(true);
  });

  it('turning off records the choice and deletes every stored number', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    await writeSettings(f.deps.configPath, { identifierStorage: true });
    await f.store.putIdentifiers(f.hash, [{ field: 'id_number', value: 'AB1234567' }]);
    const out = captureStdout();
    expect(
      await runSettings(['identifier-storage', 'off'], {
        ...f.deps,
        interactive: false,
        confirm: never,
      }),
    ).toBe(0);
    expect(out.mock.calls.join('')).toMatch(/off\. Deleted 1 stored ID number/);
    expect(await f.store.countIdentifiers()).toBe(0);
    expect(f.store.close).toHaveBeenCalledTimes(1);
    expect((await readSettings(f.deps.configPath)).settings.identifierStorage).toBe(false);
  });

  it('turning off with no store yet does not create one', async () => {
    const f = await vaultFixture({ databaseExists: false });
    dir = f.dir;
    const open = vi.fn(f.deps.openStorage);
    captureStdout();
    expect(
      await runSettings(['identifier-storage', 'off'], {
        ...f.deps,
        openStorage: open,
        interactive: false,
        confirm: never,
      }),
    ).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect((await readSettings(f.deps.configPath)).settings.identifierStorage).toBe(false);
  });

  it('turning off when the store cannot be opened saves the setting and says the purge is pending', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    await writeSettings(f.deps.configPath, { identifierStorage: true });
    captureStdout();
    const err = captureStderr();
    expect(
      await runSettings(['identifier-storage', 'off'], {
        ...f.deps,
        openStorage: async () => {
          throw new Error('Keychain locked');
        },
        interactive: false,
        confirm: never,
      }),
    ).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/Keychain locked/);
    expect(err.mock.calls.join('')).toMatch(/next scan deletes them/);
    expect((await readSettings(f.deps.configPath)).settings.identifierStorage).toBe(false);
  });

  it('rejects an unknown setting or value', async () => {
    const f = await vaultFixture();
    dir = f.dir;
    const err = captureStderr();
    const deps = { ...f.deps, interactive: false, confirm: never };
    expect(await runSettings(['colour', 'blue'], deps)).toBe(1);
    expect(await runSettings(['identifier-storage', 'maybe'], deps)).toBe(1);
    expect(err.mock.calls.join('')).toMatch(/usage: outtray settings/);
  });
});
