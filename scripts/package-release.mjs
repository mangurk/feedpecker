import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const releaseDirectory = path.join(root, 'release');
const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
const archiveName = `feedpecker-v${manifest.version}.zip`;

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

const result = spawnSync('zip', ['-qr', path.join(releaseDirectory, archiveName), '.', '-x', '*/.DS_Store', '.DS_Store'], {
  cwd: dist,
  encoding: 'utf8'
});

if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || 'Could not create release archive');
}

console.log(`Packaged release/${archiveName}`);
