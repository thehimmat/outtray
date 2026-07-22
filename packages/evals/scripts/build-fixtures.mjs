// Dev-only fixture builder (NOT run in CI). Regenerates the committed synthetic
// fixture set: writes each fixture's HTML + labels, renders the HTML to PNG with
// headless Chrome, and writes the manifest with SHA-256 checksums.
//
// Usage: pnpm build && node packages/evals/scripts/build-fixtures.mjs
// Requires Google Chrome installed (see the path below).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFixtures } from '../dist/fixtures/generate.js';

const SEED = 20260722;
const VARIANTS = 2;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');
const outDir = join(fixturesDir, 'synthetic');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function render(htmlPath, pngPath) {
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=816,1000',
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: 'ignore' },
  );
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const specs = generateFixtures(SEED, VARIANTS);
const entries = [];
for (const spec of specs) {
  const htmlPath = join(outDir, `${spec.id}.html`);
  const labelsPath = join(outDir, `${spec.id}.labels.json`);
  const pngPath = join(outDir, `${spec.id}.png`);

  writeFileSync(htmlPath, spec.html);
  writeFileSync(labelsPath, `${JSON.stringify(spec.labels, null, 2)}\n`);
  render(htmlPath, pngPath);

  entries.push({
    id: spec.id,
    type: spec.type,
    provenance: 'synthetic',
    files: {
      html: { path: `synthetic/${spec.id}.html`, sha256: sha256(readFileSync(htmlPath)) },
      labels: {
        path: `synthetic/${spec.id}.labels.json`,
        sha256: sha256(readFileSync(labelsPath)),
      },
      png: { path: `synthetic/${spec.id}.png`, sha256: sha256(readFileSync(pngPath)) },
    },
  });
  process.stdout.write(`rendered ${spec.id}\n`);
}

const manifest = {
  seed: SEED,
  variantsPerType: VARIANTS,
  count: entries.length,
  fixtures: entries,
};
writeFileSync(join(fixturesDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`wrote manifest with ${entries.length} fixtures\n`);
