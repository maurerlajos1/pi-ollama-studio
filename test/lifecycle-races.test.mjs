import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(30);
  }
  return false;
}

test('ManagedOllama serializes concurrent starts and leaves no orphan after stop', { skip: process.platform === 'win32' ? 'Windows wrapper PID differs from the direct exec PID; descendant cleanup is covered by the Windows release gate.' : false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-ollama-lifecycle-'));
  const appDir = path.join(root, 'studio');
  const launches = path.join(root, 'launches.txt');
  const server = path.join(root, 'fake-ollama.mjs');
  const wrapper = path.join(root, `fake-ollama${process.platform === 'win32' ? '.cmd' : ''}`);
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(server, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(launches)}, String(process.pid) + '\\n');
setInterval(() => {}, 1000);
`);
  await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 });
  if (process.platform === 'win32') await fs.writeFile(wrapper, `@"${process.execPath}" "${server}" %*\r\n`);
  process.env.PI_OLLAMA_STUDIO_DIR = appDir;
  process.env.OLLAMA_COMMAND = wrapper;
  const { ManagedOllama } = await import(`../src/system.mjs?lifecycle=${Date.now()}`);
  const manager = new ManagedOllama();
  t.after(async () => {
    await manager.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  const [a, b] = await Promise.all([manager.start(), manager.start()]);
  assert.equal(a.running, true);
  assert.equal(b.running, true);
  assert.equal(a.pid, b.pid, 'concurrent starts should share the same managed server');
  const pids = (await fs.readFile(launches, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
  assert.deepEqual(pids, [a.pid], 'only one Ollama process should be spawned');

  await manager.stop();
  assert.equal(await waitUntil(() => !pidAlive(a.pid)), true, 'managed Ollama process should be gone after stop');
});

test('ManagedOllama cleans descendant workers after an unexpected server crash', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-ollama-crash-'));
  const appDir = path.join(root, 'studio');
  const workerFile = path.join(root, 'worker.mjs');
  const server = path.join(root, 'crash-ollama.mjs');
  const wrapper = path.join(root, `crash-ollama${process.platform === 'win32' ? '.cmd' : ''}`);
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(workerFile, `setInterval(() => {}, 1000);\n`);
  await fs.writeFile(server, `
import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(workerFile)}], { stdio:'ignore' });
setTimeout(() => process.exit(17), 850);
setInterval(() => {}, 1000);
`);
  await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 });
  if (process.platform === 'win32') await fs.writeFile(wrapper, `@"${process.execPath}" "${server}" %*\r\n`);
  process.env.PI_OLLAMA_STUDIO_DIR = appDir;
  process.env.OLLAMA_COMMAND = wrapper;
  // This test shares the module config with the first test; write the command into its active runtime store too.
  const { CONFIG_PATH, DEFAULT_CONFIG, writeJsonAtomic } = await import('../src/config.mjs');
  await writeJsonAtomic(CONFIG_PATH, { ...DEFAULT_CONFIG, ollamaCommand: wrapper });
  const { ManagedOllama } = await import(`../src/system.mjs?crash=${Date.now()}`);
  const manager = new ManagedOllama();
  t.after(async () => { await manager.stop().catch(() => {}); await fs.rm(root, { recursive:true, force:true }); });
  const started = await manager.start();
  const groupPid = started.pid;
  assert.ok(groupPid);
  const crashed = await waitUntil(() => !manager.running, 3000);
  assert.equal(crashed, true, 'managed Ollama leader should crash');
  const groupGone = await waitUntil(() => { try { process.kill(-groupPid, 0); return false; } catch { return true; } }, 3000);
  assert.equal(groupGone, true, 'unexpected Ollama exit must clean the remaining process group');
});
