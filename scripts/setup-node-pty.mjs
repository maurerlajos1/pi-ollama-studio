import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'vendor', 'packages', 'node-pty-1.1.0.tgz');
const TARGET = path.join(ROOT, 'node_modules', 'node-pty');
const PREBUILT = new Set(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']);
const platformKey = `${process.platform}-${process.arch}`;

async function canImport() {
  try {
    const mod = await import('node-pty');
    return Boolean((mod.default || mod)?.spawn);
  } catch { return false; }
}

if (await canImport()) {
  console.log(`PASS: node-pty is already available for ${platformKey}`);
  process.exit(0);
}

if (!PREBUILT.has(platformKey)) {
  console.log(`SKIP: bundled node-pty has no ${platformKey} prebuild.`);
  console.log('Studio will use its pipe terminal fallback. For a full PTY on Linux, install/build node-pty 1.1.0 with your system toolchain.');
  process.exit(0);
}

await fs.access(SOURCE);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-node-pty-'));
try {
  const extract = spawnSync('tar', ['-xzf', SOURCE, '-C', temp], { stdio: 'inherit', shell: false });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(`tar exited with code ${extract.status}`);
  const unpacked = path.join(temp, 'package');
  await fs.rm(TARGET, { recursive: true, force: true });
  await fs.mkdir(path.dirname(TARGET), { recursive: true });
  await fs.cp(unpacked, TARGET, { recursive: true });
  if (!(await canImport())) throw new Error(`node-pty extracted but its ${platformKey} prebuild could not be loaded by Node ${process.version}`);
  console.log(`PASS: installed bundled node-pty 1.1.0 prebuild for ${platformKey}`);
} finally {
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
