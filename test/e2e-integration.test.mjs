import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

async function waitFor(url, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const response = await fetch(url); if (response.ok) return response; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not respond at ${url}`);
}

test('Full E2E UI-Backend Integration Test Suite for Pi, Ollama, Git, Files, & Terminals', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-e2e-home-'));
  const workspace = path.join(home, 'test-workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'index.js'), 'console.log("hello e2e");\n');

  const port = 44800 + Math.floor(Math.random() * 800);
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      STUDIO_PORT: String(port),
      OLLAMA_MODELS: 'H:\\ollama-models'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(async () => {
    child.stdout.destroy();
    child.stderr.destroy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    await fs.rm(home, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/bootstrap`);

  // 1. Bootstrap & Server Health
  await t.test('E2E: Bootstrap returns system, Ollama, and Pi metadata', async () => {
    const res = await fetch(`${base}/api/bootstrap`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.config, 'object');
    assert.equal(typeof data.ollama, 'object');
    assert.equal(typeof data.system, 'object');
  });

  // 2. Runtime Configuration Updates
  await t.test('E2E: PUT /api/config validates and updates runtime settings', async () => {
    const updateRes = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ defaultContextLength: 32768, keepAlive: '15m' })
    });
    assert.equal(updateRes.status, 200);
    const updateData = await updateRes.json();
    assert.equal(updateData.ok, true);
    assert.equal(updateData.config.defaultContextLength, 32768);
    assert.equal(updateData.config.keepAlive, '15m');
  });

  // 3. Workspace File Tree & File Reading/Writing
  await t.test('E2E: Workspace tree, folder picker endpoint, file reading/saving, and containment', async () => {
    const pickerRes = await fetch(`${base}/api/workspace/select-folder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ current: workspace })
    });
    assert.equal(pickerRes.status, 200);
    const pickerData = await pickerRes.json();
    assert.equal(typeof pickerData, 'object');
    const browseRes = await fetch(`${base}/api/workspace/browse?path=${encodeURIComponent(workspace)}`);
    assert.equal(browseRes.status, 200);
    const browseData = await browseRes.json();
    assert.equal(browseData.ok, true);
    assert.equal(Array.isArray(browseData.folders), true);
    assert.equal(Array.isArray(browseData.drives), true);

    const treeRes = await fetch(`${base}/api/workspace/tree?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(treeRes.status, 200);
    const treeData = await treeRes.json();
    assert.equal(treeData.ok, true);
    assert.equal(Array.isArray(treeData.tree.entries), true);

    const fileRes = await fetch(`${base}/api/workspace/file?workspace=${encodeURIComponent(workspace)}&path=index.js`);
    assert.equal(fileRes.status, 200);
    const fileData = await fileRes.json();
    assert.equal(fileData.file.content, 'console.log("hello e2e");\n');

    const saveRes = await fetch(`${base}/api/workspace/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: 'index.js', content: 'console.log("updated e2e");\n' })
    });
    assert.equal(saveRes.status, 200);

    // Containment security check: Path escape rejection
    const escapeRes = await fetch(`${base}/api/workspace/file?workspace=${encodeURIComponent(workspace)}&path=../secret.txt`);
    assert.equal(escapeRes.status, 403);
  });

  // 4. Git Integration APIs
  await t.test('E2E: Git status, diff, stage, and path safety', async () => {
    const statusRes = await fetch(`${base}/api/workspace/git?workspace=${encodeURIComponent(workspace)}`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.ok, true);
    assert.equal(typeof statusData.git, 'object');

    // Diff path escape check
    const escapeDiff = await fetch(`${base}/api/workspace/git/diff?workspace=${encodeURIComponent(workspace)}&path=../../etc/passwd`);
    assert.equal(escapeDiff.status, 403);

    // Stage path escape check
    const escapeStage = await fetch(`${base}/api/workspace/git/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ workspace, path: '../../etc/passwd', stage: true })
    });
    assert.equal(escapeStage.status, 403);
  });

  // 5. Ollama Status, Diagnostics, Profiles, & Sync
  await t.test('E2E: Ollama status, profile creation, and diagnostics', async () => {
    const statusRes = await fetch(`${base}/api/ollama/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.ok, true);
    assert.equal(typeof statusData.ollama.online, 'boolean');

    const profileRes = await fetch(`${base}/api/ollama/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        baseModel: 'llama3.2:latest',
        name: 'e2e-test-profile',
        contextWindow: 32768,
        maxTokens: 4096,
        reasoning: false
      })
    });
    assert.equal(profileRes.status, 200);
    const profileData = await profileRes.json();
    assert.equal(profileData.ok, true);
    assert.equal(profileData.profile.name, 'e2e-test-profile');
  });

  // 6. Terminal Session Management & Command Security
  await t.test('E2E: Terminal session listing and kill', async () => {
    const listRes = await fetch(`${base}/api/terminal/sessions`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.ok, true);
    assert.equal(Array.isArray(listData.sessions), true);

    const killRes = await fetch(`${base}/api/terminal/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ id: 'non-existent-id' })
    });
    assert.equal(killRes.status, 200);
  });

  // 7. Real-Time Server-Sent Events (SSE) Handshake
  await t.test('E2E: SSE /api/events broadcasts initial connection handshake', async () => {
    const sseEventPromise = new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events' }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        res.on('data', (chunk) => {
          const str = String(chunk);
          if (str.includes('event: connected')) {
            res.destroy();
            resolve(true);
          }
        });
      });
      req.on('error', reject);
    });
    const connected = await sseEventPromise;
    assert.equal(connected, true);
  });
});
