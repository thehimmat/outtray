import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateFixtures } from './generate.js';
import { fixturesRoot, loadFixture, loadManifest, verifyManifest } from './load.js';

describe('fixture manifest', () => {
  it('has at least 10 synthetic fixtures', async () => {
    const manifest = await loadManifest();
    expect(manifest.count).toBeGreaterThanOrEqual(10);
    expect(manifest.fixtures).toHaveLength(manifest.count);
    for (const f of manifest.fixtures) expect(f.provenance).toBe('synthetic');
  });

  it('every file matches its checksum and nothing is unmanifested', async () => {
    const problems = await verifyManifest(await loadManifest());
    expect(problems).toEqual([]);
  });

  it('HTML and labels are reproducible from the committed seed', async () => {
    const manifest = await loadManifest();
    const specs = generateFixtures(manifest.seed, manifest.variantsPerType);
    const root = fixturesRoot();
    for (const spec of specs) {
      const html = await readFile(join(root, 'synthetic', `${spec.id}.html`), 'utf8');
      const labels = await readFile(join(root, 'synthetic', `${spec.id}.labels.json`), 'utf8');
      expect(html).toBe(spec.html);
      expect(JSON.parse(labels)).toEqual(spec.labels);
    }
  });

  it('loads a fixture with labels and a base64 image', async () => {
    const manifest = await loadManifest();
    const entry = manifest.fixtures[0];
    if (!entry) throw new Error('no fixtures');
    const fixture = await loadFixture(entry);
    expect(fixture.labels.type).toBe(entry.type);
    expect(fixture.imageBase64.length).toBeGreaterThan(100);
  });
});
