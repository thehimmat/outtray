// @vitest-environment node
import {
  type EmbeddingProvider,
  type GenerateResult,
  MemoryStorage,
  type ModelProvider,
} from '@outtray/core';
import { describe, expect, it } from 'vitest';
import { type Invoke, tauriApi, tauriFolderSource } from './tauri-api.js';

const usage = { loadMs: 0, promptTokens: 1, genTokens: 1, genTokPerSec: 1, totalMs: 1 };

const BILL = {
  type: 'bill',
  summary: 'Metro Electric bill.',
  action_items: [{ text: 'Pay Metro Electric $91.00', due_date: '2027-02-16' }],
  payee: 'Metro Electric',
  amount_due: '$91.00',
  due_date: '2027-02-16',
  late_fee: null,
};

class FakeProvider implements ModelProvider {
  readonly name = 'fake';
  calls = 0;
  constructor(private readonly failure: Error | null = null) {}
  async generate(): Promise<GenerateResult> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return {
      json: BILL,
      jsonChannel: 'content',
      content: '',
      thinking: '',
      doneReason: 'stop',
      usage,
    };
  }
}

class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake-embed';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0, 0]);
  }
}

/** How each store op's named args map onto `StorageProvider` positional args. */
const ARGS: Record<string, string[]> = {
  putDocument: ['document'],
  getDocument: ['contentHash'],
  listDocuments: [],
  deleteDocument: ['contentHash'],
  putChunks: ['contentHash', 'chunks'],
  listChunks: [],
  addLabels: ['labels'],
  listLabels: [],
  replaceDocumentLabels: ['documentHash', 'labels'],
  updateLabelEmbedding: ['id', 'embedding', 'embedModel'],
  putIdentifiers: ['documentHash', 'identifiers'],
  getIdentifier: ['documentHash', 'field'],
  identifierFields: ['documentHash'],
  purgeIdentifiers: [],
  countIdentifiers: [],
  setReview: ['review'],
  clearReview: ['key'],
  listReviews: [],
  close: [],
};

/**
 * The shell's commands, in memory: the store is a `MemoryStorage` that
 * survives close and reopen, like the file on disk.
 */
function fakeShell(files: Record<string, Uint8Array>, options: { storeFails?: boolean } = {}) {
  const store = new MemoryStorage();
  const log: string[] = [];
  let open = false;
  const invoke = (async (command: string, args: Record<string, unknown> = {}) => {
    log.push(command === 'store_command' ? `store:${String(args.op)}` : command);
    switch (command) {
      case 'store_open':
        if (options.storeFails) throw { kind: 'key', message: 'The Keychain refused.' };
        open = true;
        return null;
      case 'store_command': {
        if (!open) throw { kind: 'storage', message: 'Storage is closed.' };
        const op = String(args.op);
        const named = (args.args ?? {}) as Record<string, unknown>;
        if (op === 'close') {
          open = false;
          return null;
        }
        const method = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
        const positional = (ARGS[op] ?? []).map((name) => named[name]);
        return (await method?.apply(store, positional)) ?? null;
      }
      case 'list_folder':
        return Object.keys(files);
      case 'read_file': {
        const name = String(args.path).split('/').pop() ?? '';
        const bytes = files[name];
        if (!bytes) throw { kind: 'storage', message: `Cannot read ${String(args.path)}` };
        return bytes.slice().buffer;
      }
      case 'read_settings':
        return { identifierStorage: false };
      default:
        throw new Error(`unknown command ${command}`);
    }
  }) as Invoke;
  return { invoke, store, log, isOpen: () => open };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function api(invoke: Invoke, provider = new FakeProvider()) {
  return tauriApi({
    invoke,
    pickFolder: async () => '/docs',
    models: { provider, embedder: new FakeEmbedder() },
    today: () => '2027-02-01',
  });
}

describe('tauriFolderSource', () => {
  it('lists, reads and locates through the shell commands', async () => {
    const shell = fakeShell({ 'bill.png': PNG });
    const source = tauriFolderSource(shell.invoke, '/docs/');
    expect(await source.list()).toEqual(['bill.png']);
    expect(source.locate('bill.png')).toBe('/docs/bill.png');
    const bytes = await source.read('bill.png');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([...PNG]);
  });
});

describe('tauriApi', () => {
  it('plans a folder and saves it to the store, then reuses it on the next run', async () => {
    const shell = fakeShell({ 'bill.png': PNG, 'notes.txt': new Uint8Array([1]) });
    const provider = new FakeProvider();

    const first = await api(shell.invoke, provider).planFolder('/docs');
    expect(first.scanned).toBe(1);
    expect(first.skipped).toEqual(['notes.txt']);
    expect(first.queue.items.some((a) => a.kind === 'todo')).toBe(true);
    expect(first.notes).toContain('Saved 1 document(s) to the encrypted store.');
    expect((await shell.store.listDocuments()).map((d) => d.path)).toEqual(['/docs/bill.png']);
    expect(shell.isOpen()).toBe(false);
    const callsAfterFirst = provider.calls;

    const second = await api(shell.invoke, provider).planFolder('/docs');
    expect(provider.calls).toBe(callsAfterFirst);
    expect(second.notes).toContain(
      'Saved 1 document(s) to the encrypted store, 1 unchanged since the last scan.',
    );
  });

  it('never asks the webview for a key or path when opening the store', async () => {
    const calls: Array<[string, unknown]> = [];
    const shell = fakeShell({ 'bill.png': PNG });
    const spy = (async (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      return shell.invoke(command, args);
    }) as Invoke;
    await api(spy).planFolder('/docs');
    expect(calls.find(([c]) => c === 'store_open')).toEqual(['store_open', undefined]);
  });

  it('still plans when the store cannot be opened, and says so', async () => {
    const shell = fakeShell({ 'bill.png': PNG }, { storeFails: true });
    const planned = await api(shell.invoke).planFolder('/docs');
    expect(planned.scanned).toBe(1);
    expect(planned.notes[0]).toMatch(/^Not saved to the encrypted store:/);
    expect(shell.log).not.toContain('store:putDocument');
  });

  it('explains an unreachable local model and closes the store', async () => {
    const shell = fakeShell({ 'bill.png': PNG });
    const provider = new FakeProvider(new TypeError('Failed to fetch'));
    await expect(api(shell.invoke, provider).planFolder('/docs')).rejects.toThrow(/Start Ollama/);
    expect(shell.log).toContain('store:close');
    expect(shell.isOpen()).toBe(false);
  });

  it('saves a Reviewed mark that the next plan reads back, even after a rename', async () => {
    const files: Record<string, Uint8Array> = { 'bill.png': PNG };
    const shell = fakeShell(files);
    const host = api(shell.invoke);
    const first = await host.planFolder('/docs');
    expect(first.reviewed).toEqual([]);
    const id = first.queue.items[0]?.id ?? '';
    await host.setReviewed(id, true);
    expect(shell.isOpen()).toBe(false);
    expect((await host.planFolder('/docs')).reviewed).toEqual([id]);

    delete files['bill.png'];
    files['renamed.png'] = PNG;
    const renamed = await host.planFolder('/docs');
    expect(renamed.reviewed).toEqual([renamed.queue.items[0]?.id]);

    await host.setReviewed(renamed.reviewed[0] ?? '', false);
    expect((await host.planFolder('/docs')).reviewed).toEqual([]);
  });

  it('starts a re-issued document unreviewed', async () => {
    const files: Record<string, Uint8Array> = { 'bill.png': PNG };
    const shell = fakeShell(files);
    const host = api(shell.invoke);
    const first = await host.planFolder('/docs');
    await host.setReviewed(first.queue.items[0]?.id ?? '', true);
    files['bill.png'] = new Uint8Array([...PNG, 9]);
    expect((await host.planFolder('/docs')).reviewed).toEqual([]);
  });

  it('refuses to save a mark for an item it did not plan, or without a store', async () => {
    const shell = fakeShell({ 'bill.png': PNG });
    const host = api(shell.invoke);
    await expect(host.setReviewed('nope', true)).rejects.toThrow(/plan the folder again/);
    const failing = fakeShell({ 'bill.png': PNG }, { storeFails: true });
    const noStore = api(failing.invoke);
    const planned = await noStore.planFolder('/docs');
    await expect(noStore.setReviewed(planned.queue.items[0]?.id ?? '', true)).rejects.toThrow(
      /Keychain refused/,
    );
  });

  it('saves two quick ticks one after the other, since the shell holds one store', async () => {
    const shell = fakeShell({ 'a.png': PNG, 'b.png': new Uint8Array([...PNG, 1]) });
    const host = api(shell.invoke);
    const planned = await host.planFolder('/docs');
    const ids = planned.queue.items.map((i) => i.id);
    expect(ids.length).toBeGreaterThan(1);
    await Promise.all(ids.map((id) => host.setReviewed(id, true)));
    expect((await host.planFolder('/docs')).reviewed.sort()).toEqual([...ids].sort());
  });
});
