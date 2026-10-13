import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('.', import.meta.url).pathname;

/** Every module reachable from `entry` by relative imports, with its non-relative imports. */
async function graph(entry: string): Promise<Map<string, string[]>> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const text = await readFile(join(SRC, file), 'utf8');
    const specifiers = [...text.matchAll(/(?:import|export)[^'"]*?from\s+'([^']+)'/g)].map(
      (m) => m[1] as string,
    );
    seen.set(
      file,
      specifiers.filter((s) => !s.startsWith('.')),
    );
    for (const s of specifiers.filter((x) => x.startsWith('./'))) {
      queue.push(s.slice(2).replace(/\.js$/, '.ts'));
    }
  }
  return seen;
}

describe('entry points (ADR-0013)', () => {
  it('the default entry reaches no node: module and no native module, so it runs in the webview', async () => {
    const offenders: string[] = [];
    for (const [file, externals] of await graph('index.ts')) {
      for (const ext of externals) {
        if (ext.startsWith('node:') || ext.includes('sqlite')) offenders.push(`${file} -> ${ext}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the node entry is where the Node adapters live', async () => {
    const files = [...(await graph('node.ts')).keys()];
    expect(files).toEqual(
      expect.arrayContaining(['storage-sqlcipher.ts', 'db-key.ts', 'settings.ts', 'app-paths.ts']),
    );
  });
});
