import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions, inspectSession } from '../src/sessions.mjs';

test('lists and inspects Pi JSONL sessions', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-session-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const dir = path.join(workspace, '.pi', 'studio-sessions');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'abc.jsonl');
  await fs.writeFile(file, [
    JSON.stringify({ type: 'session', id: 'abc', name: 'Test session', cwd: workspace }),
    JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'm1', name: 'Renamed session' }),
    ''
  ].join('\n'));
  const sessions = await listSessions(workspace);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'abc');
  assert.equal(sessions[0].name, 'Renamed session');
  const inspected = await inspectSession(workspace, file);
  assert.equal(inspected.entries.length, 3);
  assert.deepEqual(inspected.errors, []);
});

test('session inspection cannot read arbitrary JSONL files outside the workspace', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-session-safe-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-session-outside-'));
  t.after(() => Promise.all([
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true })
  ]));
  await fs.mkdir(path.join(workspace, '.pi', 'studio-sessions'), { recursive: true });
  const file = path.join(outside, 'secret.jsonl');
  await fs.writeFile(file, '{}\n');
  await assert.rejects(() => inspectSession(workspace, file), /outside the selected workspace/);
});


test('workspace session storage rejects symlinked .pi directories', { skip: process.platform === 'win32' }, async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-session-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-session-link-outside-'));
  t.after(() => Promise.all([
    fs.rm(workspace, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true })
  ]));
  await fs.symlink(outside, path.join(workspace, '.pi'));
  await assert.rejects(() => listSessions(workspace), /may not be a symbolic link/);
});
