/**
 * Load and verify the committed synthetic fixture set.
 *
 * The manifest is the source of truth: every committed fixture file must appear
 * in it with a matching SHA-256, and the HTML + labels must be reproducible
 * from the generator seed (fixture policy in packages/evals/fixtures/README.md).
 * The harness reads fixtures through here so it always sees manifest-verified
 * inputs.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentType } from '@outtray/core';
import { sha256Hex } from '../hash.js';
import type { FixtureLabels } from './generate.js';

/** A checksummed file reference within the manifest. */
export interface ManifestFile {
  path: string;
  sha256: string;
}

/** One fixture's manifest entry. */
export interface ManifestEntry {
  id: string;
  type: DocumentType;
  provenance: 'synthetic';
  files: { html: ManifestFile; labels: ManifestFile; png: ManifestFile };
}

/** The fixture manifest. */
export interface Manifest {
  seed: number;
  variantsPerType: number;
  count: number;
  fixtures: ManifestEntry[];
}

/** A fixture ready to score: its labels and the page image as base64. */
export interface LoadedFixture {
  id: string;
  type: DocumentType;
  labels: FixtureLabels;
  imageBase64: string;
}

/** Absolute path to `packages/evals/fixtures` (works from both src and dist). */
export function fixturesRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
}

/** Read and parse the manifest. */
export async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(join(fixturesRoot(), 'manifest.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

/** Read a fixture's labels and page image (base64), by manifest entry. */
export async function loadFixture(entry: ManifestEntry): Promise<LoadedFixture> {
  const root = fixturesRoot();
  const labels = JSON.parse(
    await readFile(join(root, entry.files.labels.path), 'utf8'),
  ) as FixtureLabels;
  const png = await readFile(join(root, entry.files.png.path));
  return { id: entry.id, type: entry.type, labels, imageBase64: png.toString('base64') };
}

/**
 * Verify every manifest file exists with a matching checksum, and that no file
 * in `synthetic/` is missing from the manifest.
 *
 * Failure modes: never throws; returns the list of problems (empty when clean)
 * so a test can assert on it and CI can fail with a precise message.
 */
export async function verifyManifest(manifest: Manifest): Promise<string[]> {
  const root = fixturesRoot();
  const problems: string[] = [];
  const manifested = new Set<string>();

  for (const entry of manifest.fixtures) {
    for (const ref of Object.values(entry.files)) {
      manifested.add(ref.path);
      try {
        const bytes = await readFile(join(root, ref.path));
        const actual = sha256Hex(bytes);
        if (actual !== ref.sha256) {
          problems.push(
            `checksum mismatch: ${ref.path} (manifest ${ref.sha256}, actual ${actual})`,
          );
        }
      } catch {
        problems.push(`missing file: ${ref.path}`);
      }
    }
  }

  const onDisk = await readdir(join(root, 'synthetic'));
  for (const name of onDisk) {
    if (!manifested.has(`synthetic/${name}`)) {
      problems.push(`unmanifested file: synthetic/${name}`);
    }
  }

  return problems;
}
