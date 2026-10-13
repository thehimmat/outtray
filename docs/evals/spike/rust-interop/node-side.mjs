// Node half of the #75 interop spike. Writes a store through the shipped
// code (openSqlcipherStorage, persistScan with a vaulted identifier and a
// 768-dim chunk), runs the Rust binary against it, then reopens it in Node
// and reads the label Rust wrote. Last, proves a wrong key fails from Rust.
//
// Usage (from packages/cli, so @outtray/core resolves, after pnpm build and
// cargo build --release in this directory):
//   cp ../../docs/evals/spike/rust-interop/node-side.mjs ./interop-tmp.mjs
//   node interop-tmp.mjs ../../docs/evals/spike/rust-interop/target/release/outtray-sqlcipher-interop
//   rm interop-tmp.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateDatabaseKey,
  openSqlcipherStorage,
  persistScan,
  StaticKeyProvider,
} from '@outtray/core';

const bin = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), 'interop-'));
const path = join(dir, 'outtray.db');
const key = generateDatabaseKey();
const provider = new StaticKeyProvider(key);
let store = await openSqlcipherStorage({ path, keyProvider: provider });
const doc = {
  type: 'policy',
  summary: 'Auto policy.',
  action_items: [],
  insurer: 'Harbor',
  policy_number: 'POL-804220',
  coverage_summary: 'auto',
  expiry_date: '2026-12-16',
};
const usage = { loadMs: 0, promptTokens: 0, genTokens: 0, genTokPerSec: null, totalMs: 0 };
const report = {
  scanned: ['p.png'],
  skipped: [],
  classifierError: null,
  items: [
    {
      file: 'p.png',
      contentHash: 'h-policy',
      result: { valid: true, jsonChannel: 'content', raw: doc, usage, error: null, document: doc },
      reconciliation: {
        effectiveType: 'policy',
        status: 'unclassified',
        review: false,
        vlmType: 'policy',
        classification: null,
      },
    },
  ],
};
const chunks = new Map([
  [
    'h-policy',
    [
      {
        documentHash: 'h-policy',
        chunkIndex: 0,
        page: null,
        text: 'Auto policy. policy_number: [policy_number]',
        embedding: Array.from({ length: 768 }, (_, i) => Math.sin(i)),
      },
    ],
  ],
]);
await persistScan(store, report, {
  dir,
  identifierStorage: true,
  extractorKey: 'qwen3-vl:2b|extract-v1|extract-typed-v1',
  index: { key: 'nomic-embed-text|chunk-v1|tokenize-v1', chunks },
});
await store.addLabels([
  {
    type: 'bill',
    embedding: [1, 2],
    provenance: 'seed',
    documentHash: null,
    text: null,
    embedModel: 'm',
  },
]);
await store.close();
console.log(
  execFileSync(bin, [path, key.toString('hex')])
    .toString()
    .trim(),
);
store = await openSqlcipherStorage({ path, keyProvider: provider });
const labels = await store.listLabels();
console.log(
  'node reads rust label:',
  JSON.stringify(labels.find((l) => l.embedModel === 'rust-spike')),
);
console.log(
  'node still reads document:',
  (await store.getDocument('h-policy'))?.extraction?.policy_number,
);
await store.close();
try {
  execFileSync(bin, [path, 'ab'.repeat(32)], { stdio: 'pipe' });
  console.log('WRONG KEY OPENED?!');
} catch (e) {
  console.log('wrong key from rust fails:', e.stderr.toString().trim().split('\n').pop());
}
