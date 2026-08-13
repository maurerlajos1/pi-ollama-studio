import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('checkpoint metadata serializes concurrent writes without losing nodes', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-checkpoint-store-'));
  const appDir = path.join(base, 'app');
  const workspace = path.join(base, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const code = `
    import { recordCheckpoint, listCheckpoints } from './src/checkpoints.mjs';
    const workspace = process.env.TEST_WORKSPACE;
    await Promise.all(Array.from({length: 30}, (_, i) => recordCheckpoint(workspace, 'node-'+i, { commit: String(i).padStart(40, 'a') })));
    process.stdout.write(JSON.stringify(await listCheckpoints(workspace)));
  `;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      env: { ...process.env, PI_OLLAMA_STUDIO_DIR: appDir, TEST_WORKSPACE: workspace },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `checkpoint child exited ${code}`)));
  });
  const checkpoints = JSON.parse(output);
  assert.equal(Object.keys(checkpoints).length, 30);
  for (let i = 0; i < 30; i += 1) assert.equal(checkpoints[`node-${i}`].nodeId, `node-${i}`);
});

test('checkpoint lookup uses canonical workspace identity across symlink aliases', { skip: process.platform === 'win32' }, async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-checkpoint-alias-'));
  const appDir = path.join(base, 'app');
  const workspace = path.join(base, 'workspace');
  const alias = path.join(base, 'workspace-link');
  await fs.mkdir(workspace, { recursive: true });
  await fs.symlink(workspace, alias, 'dir');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const code = `
    import { recordCheckpoint, getCheckpoint, listCheckpoints } from './src/checkpoints.mjs';
    await recordCheckpoint(process.env.ALIAS, 'node-a', { commit: 'a'.repeat(40) });
    const physical = await getCheckpoint(process.env.WORKSPACE, 'node-a');
    await recordCheckpoint(process.env.WORKSPACE, 'node-b', { commit: 'b'.repeat(40) });
    const viaAlias = await listCheckpoints(process.env.ALIAS);
    process.stdout.write(JSON.stringify({ physical, viaAlias }));
  `;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      env: { ...process.env, PI_OLLAMA_STUDIO_DIR: appDir, ALIAS: alias, WORKSPACE: workspace },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `checkpoint alias child exited ${code}`)));
  });
  const result = JSON.parse(output);
  assert.equal(result.physical.nodeId, 'node-a');
  assert.deepEqual(Object.keys(result.viaAlias).sort(), ['node-a', 'node-b']);
});
