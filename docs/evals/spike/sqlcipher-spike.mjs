// SQLCipher build-path spike harness (throwaway; NOT pipeline code). Issue #6.
//
// Proves (or disproves) that an encrypted SQLite file can be opened, keyed,
// written, read, and rekeyed from plain Node on the target machine, and
// measures the cost of encryption against a plaintext baseline on the two
// access patterns Outtray actually has: a full embedding-BLOB scan (ADR-0005
// brute-force cosine) and a bulk write.
//
// The driver (SQLite3MultipleCiphers) supports several cipher schemes. The
// battery runs twice: once under the driver default (chacha20) and once under
// `PRAGMA cipher = 'sqlcipher'`, because only the latter produces a file the
// wider SQLCipher ecosystem (notably Rust `rusqlite` with `bundled-sqlcipher`,
// the likely Phase 3 reader) can open.
//
// Usage, from a throwaway dir where the driver is installed:
//   npm i better-sqlite3-multiple-ciphers
//   node /path/to/docs/evals/spike/sqlcipher-spike.mjs [outdir]
//
// Resolution is deliberately cwd-relative (createRequire on cwd) so the
// harness can live in the repo while its native dependency never enters the
// workspace lockfile.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requireFromCwd = createRequire(`${process.cwd()}/__spike__.cjs`);
const Database = requireFromCwd('better-sqlite3-multiple-ciphers');
const driverVersion = requireFromCwd('better-sqlite3-multiple-ciphers/package.json').version;

const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'sqlcipher-spike-'));
mkdirSync(OUT, { recursive: true });

const DIMS = 768; // upper end of the ADR-0005 embedding range
const ROWS = 5000; // ~5x the expected personal-corpus chunk count (10^3)
const PASSPHRASE = 'correct horse battery staple';

const now = () => process.hrtime.bigint();
const ms = (t) => Number((Number(process.hrtime.bigint() - t) / 1e6).toFixed(1));
const pct = (a, b) => Number((((a - b) / b) * 100).toFixed(1));

// A 32-byte key is what the macOS Keychain would actually hold (ADR-0007).
// Passed as a raw key blob so the cipher skips its passphrase KDF entirely.
const rawKeyPragma = (k) => `"x'${k.toString('hex')}'"`;
const embedding = () => {
  const f = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) f[i] = Math.random() * 2 - 1;
  return Buffer.from(f.buffer);
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    content_hash TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    doc_type TEXT,
    extracted_json TEXT
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
`;

function seed(db, rows) {
  db.exec(SCHEMA);
  const insertDoc = db.prepare(
    'INSERT INTO documents (content_hash, path, doc_type, extracted_json) VALUES (?, ?, ?, ?)',
  );
  const insertChunk = db.prepare(
    'INSERT INTO chunks (document_id, text, embedding) VALUES (?, ?, ?)',
  );
  const tx = db.transaction((n) => {
    for (let i = 0; i < n; i++) {
      const { lastInsertRowid } = insertDoc.run(
        `hash-${i}`,
        `/fixtures/doc-${i}.pdf`,
        'bill',
        JSON.stringify({ type: 'bill', summary: `synthetic row ${i}` }),
      );
      insertChunk.run(lastInsertRowid, `chunk text for document ${i}`, embedding());
    }
  });
  const t = now();
  tx(rows);
  return ms(t);
}

// Full embedding scan: what one `outtray find` query costs once the index is
// persisted (read every BLOB, score in TypeScript per ADR-0005).
function scanCost(db) {
  const stmt = db.prepare('SELECT id, embedding FROM chunks');
  const t = now();
  let acc = 0;
  for (const row of stmt.iterate()) {
    const v = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    for (let i = 0; i < v.length; i++) acc += v[i];
  }
  return { elapsedMs: ms(t), checksum: acc };
}

/**
 * Full battery against one cipher scheme. `cipher` of null means "driver
 * default" (no `PRAGMA cipher` issued at all). `legacy` of null means "leave
 * the scheme default"; `legacy = 4` selects the upstream SQLCipher 4 wire
 * format, which is what an independent SQLCipher build can actually read.
 */
function battery(label, cipher, legacy = null) {
  const checks = [];
  const timings = {};
  const env = {};
  const check = (name, pass, detail) => {
    checks.push({ name, pass, detail: detail ?? '' });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  };

  const dbPath = join(OUT, `${label}.db`);
  rmSync(dbPath, { force: true });
  const rawKey = randomBytes(32);
  const openKeyed = (path, key) => {
    const d = new Database(path);
    if (cipher) d.pragma(`cipher = '${cipher}'`);
    if (legacy !== null) d.pragma(`legacy = ${legacy}`);
    d.pragma(`key = ${rawKeyPragma(key)}`);
    return d;
  };

  console.log(
    `\n-- battery: ${label} (cipher=${cipher ?? 'driver default'}, legacy=${legacy ?? 'scheme default'}) --`,
  );

  // 1. open, key, write, read
  const db = openKeyed(dbPath, rawKey);
  env.cipher = db.pragma('cipher', { simple: true });
  env.cipherVersion = db.pragma('cipher_version', { simple: true }) ?? null;
  env.kdfIter = db.pragma('kdf_iter', { simple: true });
  env.pageSize = db.pragma('page_size', { simple: true });
  env.sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;

  timings.seedMs = seed(db, ROWS);
  const readBack = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  check('write then read back while keyed', readBack === ROWS, `${readBack} chunks`);
  timings.scanMs = scanCost(db).elapsedMs;
  db.close();
  const sizeBytes = statSync(dbPath).size;

  // 2. reopen in a fresh process-level connection with the same key
  let reopenOk = false;
  let reopenMs = null;
  try {
    const t = now();
    const again = openKeyed(dbPath, rawKey);
    reopenOk = again.prepare('SELECT COUNT(*) AS n FROM chunks').get().n === ROWS;
    reopenMs = ms(t);
    again.close();
  } catch (err) {
    check('reopen with the same key', false, err.message);
  }
  timings.reopenMs = reopenMs;
  if (reopenOk) check('reopen with the same key', true, `${reopenMs} ms`);

  // 3. the file on disk is ciphertext, not a plaintext SQLite database.
  // Bytes 0-15 are the cipher salt by design. Bytes 16-23 are where SQLite
  // keeps page size / write version / reserved-bytes; some schemes leave that
  // struct in the clear, which is a (small) metadata leak worth recording.
  const raw = readFileSync(dbPath);
  const header = raw.subarray(0, 16).toString('latin1');
  const headerFields = raw.subarray(16, 24);
  env.saltHex = raw.subarray(0, 16).toString('hex');
  env.headerFieldsHex = headerFields.toString('hex');
  // A plaintext SQLite header struct here looks like 1000 0101 <reserved> 402020.
  env.plaintextHeaderStruct =
    headerFields[5] === 0x40 && headerFields[6] === 0x20 && headerFields[7] === 0x20;
  check(
    'on-disk header is not the plaintext SQLite magic',
    !header.startsWith('SQLite format 3'),
    `header=${JSON.stringify(header.slice(0, 15))}`,
  );
  check(
    'bytes 16-23 are not a readable SQLite header struct',
    !env.plaintextHeaderStruct,
    `bytes16_23=${env.headerFieldsHex}`,
  );

  // 4. wrong key is rejected
  let rejected = false;
  let rejectDetail = '';
  try {
    const bad = openKeyed(dbPath, randomBytes(32));
    bad.prepare('SELECT COUNT(*) FROM chunks').get();
    bad.close();
  } catch (err) {
    rejected = true;
    rejectDetail = err.message;
  }
  check('wrong key cannot read the database', rejected, rejectDetail);

  // 5. unkeyed open is rejected
  let bareRejected = false;
  try {
    const bare = new Database(dbPath);
    bare.prepare('SELECT COUNT(*) FROM chunks').get();
    bare.close();
  } catch {
    bareRejected = true;
  }
  check('unkeyed open cannot read the database', bareRejected);

  // 6. rekey (key rotation), and the old key must die
  const newKey = randomBytes(32);
  let rekeyOk = false;
  try {
    const r = openKeyed(dbPath, rawKey);
    const t = now();
    r.pragma(`rekey = ${rawKeyPragma(newKey)}`);
    timings.rekeyMs = ms(t);
    r.close();
    const after = openKeyed(dbPath, newKey);
    rekeyOk = after.prepare('SELECT COUNT(*) AS n FROM chunks').get().n === ROWS;
    after.close();
  } catch (err) {
    rejectDetail = err.message;
  }
  check('rekey rotates the key and data survives', rekeyOk, `${timings.rekeyMs} ms`);

  let oldKeyDead = false;
  try {
    const old = openKeyed(dbPath, rawKey);
    old.prepare('SELECT COUNT(*) FROM chunks').get();
    old.close();
  } catch {
    oldKeyDead = true;
  }
  check('the old key stops working after rekey', oldKeyDead);

  // 7. passphrase KDF cost (the unlock path if no Keychain key is used)
  const passPath = join(OUT, `${label}-passphrase.db`);
  rmSync(passPath, { force: true });
  const p1 = new Database(passPath);
  if (cipher) p1.pragma(`cipher = '${cipher}'`);
  if (legacy !== null) p1.pragma(`legacy = ${legacy}`);
  const tKdf = now();
  p1.pragma(`key = '${PASSPHRASE}'`);
  p1.exec('CREATE TABLE t (x)');
  p1.prepare('INSERT INTO t VALUES (1)').run();
  timings.passphraseCreateMs = ms(tKdf);
  p1.close();
  const tKdf2 = now();
  const p2 = new Database(passPath);
  if (cipher) p2.pragma(`cipher = '${cipher}'`);
  if (legacy !== null) p2.pragma(`legacy = ${legacy}`);
  p2.pragma(`key = '${PASSPHRASE}'`);
  const passOk = p2.prepare('SELECT COUNT(*) AS n FROM t').get().n === 1;
  timings.passphraseReopenMs = ms(tKdf2);
  p2.close();
  check(
    'passphrase-derived key works (KDF unlock path)',
    passOk,
    `create ${timings.passphraseCreateMs} ms, reopen ${timings.passphraseReopenMs} ms`,
  );

  return { label, cipher: cipher ?? 'driver default', env, timings, checks, sizeBytes };
}

console.log(`\n== SQLCipher spike (issue #6) ==\nout: ${OUT}`);

// Plaintext baseline: same driver, same workload, no key.
console.log('\n-- baseline: plaintext (same driver, no key) --');
const plainPath = join(OUT, 'plain.db');
rmSync(plainPath, { force: true });
const plain = new Database(plainPath);
const baseline = { seedMs: seed(plain, ROWS) };
baseline.scanMs = scanCost(plain).elapsedMs;
plain.close();
baseline.sizeBytes = statSync(plainPath).size;
const tPlainReopen = now();
const plainAgain = new Database(plainPath);
plainAgain.prepare('SELECT COUNT(*) FROM chunks').get();
baseline.reopenMs = ms(tPlainReopen);
plainAgain.close();
console.log(
  ` seed ${baseline.seedMs} ms, scan ${baseline.scanMs} ms, reopen ${baseline.reopenMs} ms`,
);

const batteries = [
  battery('default-chacha20', null),
  battery('sqlcipher-default', 'sqlcipher'),
  battery('sqlcipher-legacy4', 'sqlcipher', 4),
];

for (const b of batteries) {
  b.overheadVsPlainPct = {
    seed: pct(b.timings.seedMs, baseline.seedMs),
    scan: pct(b.timings.scanMs, baseline.scanMs),
    size: pct(b.sizeBytes, baseline.sizeBytes),
  };
}

// Interop artifact: a `cipher = 'sqlcipher'` database written with a FIXED,
// published key so an independent SQLCipher implementation (the upstream
// `sqlcipher` CLI, or Rust `rusqlite` with `bundled-sqlcipher` in Phase 3) can
// be pointed at the same file. This is the cross-ecosystem check that decides
// whether Phase 3 inherits the Phase 1/2 database or has to migrate it.
//
//   sqlcipher interop.db \
//     "PRAGMA key = \"x'<INTEROP_KEY_HEX>'\"; SELECT COUNT(*) FROM chunks;"
const INTEROP_KEY = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);
const interopPath = join(OUT, 'interop.db');
rmSync(interopPath, { force: true });
const interop = new Database(interopPath);
interop.pragma("cipher = 'sqlcipher'");
interop.pragma('legacy = 4'); // REQUIRED for upstream compatibility; see the evidence doc
interop.pragma(`key = ${rawKeyPragma(INTEROP_KEY)}`);
seed(interop, 10);
interop.close();
console.log(`\n-- interop artifact --\n ${interopPath} (key ${INTEROP_KEY.toString('hex')})`);

const results = {
  issue: 6,
  interop: { path: interopPath, keyHex: INTEROP_KEY.toString('hex'), rows: 10 },
  rows: ROWS,
  dims: DIMS,
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    driver: `better-sqlite3-multiple-ciphers@${driverVersion}`,
  },
  baseline,
  batteries,
  // The spike passes on the configuration it recommends. The two non-legacy4
  // batteries are expected to fail the header-struct check; that failure is
  // the finding, not a broken harness.
  passed: batteries.find((b) => b.label === 'sqlcipher-legacy4').checks.every((c) => c.pass),
};

console.log('\n-- summary --');
for (const b of batteries) {
  console.log(
    `${b.label}: cipher=${b.env.cipher} kdf_iter=${b.env.kdfIter} plaintextHeaderStruct=${b.env.plaintextHeaderStruct}`,
  );
  console.log(
    `  seed ${b.timings.seedMs} ms (+${b.overheadVsPlainPct.seed}%), scan ${b.timings.scanMs} ms (+${b.overheadVsPlainPct.scan}%), rekey ${b.timings.rekeyMs} ms, size +${b.overheadVsPlainPct.size}%`,
  );
  console.log(
    `  passphrase unlock ${b.timings.passphraseReopenMs} ms vs raw-key reopen ${b.timings.reopenMs} ms`,
  );
}

const resultPath = join(OUT, 'result-sqlcipher.json');
writeFileSync(resultPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\n${results.passed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} -> ${resultPath}\n`);
process.exit(results.passed ? 0 : 1);
