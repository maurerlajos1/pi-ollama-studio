import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forkSession, cloneSession, listSessions, inspectSession, createProjectFromNode, sanitizeProjectDirectoryName, buildSessionTree } from '../src/sessions.mjs';

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
  assert.ok(Array.isArray(inspected.tree));
  assert.deepEqual(inspected.errors, []);
});

test('buildSessionTree reconstructs branches for stopped and historical sessions', () => {
  const tree = buildSessionTree([
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'root' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: 'answer' } },
    { type: 'message', id: 'u2a', parentId: 'a1', message: { role: 'user', content: 'branch A' } },
    { type: 'message', id: 'u2b', parentId: 'a1', message: { role: 'user', content: 'branch B' } }
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].entry.id, 'u1');
  assert.equal(tree[0].children[0].entry.id, 'a1');
  assert.deepEqual(tree[0].children[0].children.map((node) => node.entry.id), ['u2a', 'u2b']);
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


test('forkSession keeps only the selected node ancestry and excludes sibling branches', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-session-branch-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const dir = path.join(workspace, '.pi', 'studio-sessions');
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, 'branch.jsonl');
  const entries = [
    { type: 'session_header', id: 'session', cwd: workspace },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'root' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: 'answer' } },
    { type: 'message', id: 'u2a', parentId: 'a1', message: { role: 'user', content: 'branch A' } },
    { type: 'message', id: 'a2a', parentId: 'u2a', message: { role: 'assistant', content: 'A answer' } },
    { type: 'message', id: 'u2b', parentId: 'a1', message: { role: 'user', content: 'branch B' } },
    { type: 'message', id: 'a2b', parentId: 'u2b', message: { role: 'assistant', content: 'B answer' } }
  ];
  await fs.writeFile(source, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const forked = await forkSession(workspace, source, 'a2b', 'B only');
  const inspected = await inspectSession(workspace, forked.path);
  const ids = inspected.entries.map((entry) => entry.id);
  assert.deepEqual(ids.slice(1), ['u1', 'a1', 'u2b', 'a2b']);
  assert.equal(ids.includes('u2a'), false);
  assert.equal(ids.includes('a2a'), false);
});

test('cloneSession rewrites copied session_info names so the requested clone name remains authoritative', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-session-clone-name-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const dir = path.join(workspace, '.pi', 'studio-sessions');
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, 'renamed.jsonl');
  await fs.writeFile(source, [
    JSON.stringify({ type: 'session_header', id: 'source', name: 'Original header', cwd: workspace }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'session_info', id: 'i1', parentId: 'u1', name: 'Source later rename' })
  ].join('\n') + '\n');

  const cloned = await cloneSession(workspace, source, 'Independent clone');
  const listed = await listSessions(workspace);
  const cloneMetadata = listed.find((session) => session.path === cloned.path);
  assert.equal(cloneMetadata?.name, 'Independent clone');
  const inspected = await inspectSession(workspace, cloned.path);
  assert.equal(inspected.entries.find((entry) => entry.type === 'session_info')?.name, 'Independent clone');
});


test('Create Project fallback copies current workspace code while excluding Git metadata, dependencies and old Studio sessions', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-session-project-'));
  const workspace = path.join(base, 'source');
  const targetParent = path.join(base, 'projects');
  await fs.mkdir(path.join(workspace, '.pi', 'studio-sessions'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'app.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(workspace, '.git', 'config'), 'git metadata');
  await fs.writeFile(path.join(workspace, 'node_modules', 'pkg', 'index.js'), 'dependency');
  const session = path.join(workspace, '.pi', 'studio-sessions', 'source.jsonl');
  await fs.writeFile(session, [
    JSON.stringify({ type: 'session_header', id: 'session', cwd: workspace }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'build it' } })
  ].join('\n') + '\n');
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const project = await createProjectFromNode(workspace, session, 'u1', 'copied-app', targetParent, { copyWorkspace: true });
  assert.equal(await fs.readFile(path.join(project.workspacePath, 'src', 'app.js'), 'utf8'), 'export const value = 1;\n');
  await assert.rejects(() => fs.stat(path.join(project.workspacePath, '.git')), /ENOENT/);
  await assert.rejects(() => fs.stat(path.join(project.workspacePath, 'node_modules')), /ENOENT/);
  const copiedSessions = await fs.readdir(path.join(project.workspacePath, '.pi', 'studio-sessions'));
  assert.equal(copiedSessions.length, 1, 'only the newly forked session should exist');
  await assert.rejects(() => createProjectFromNode(workspace, session, 'u1', '..', targetParent, { copyWorkspace: true }), /normal directory name/);
});


test('project directory names are portable across Windows and Linux worktree creation', () => {
  assert.equal(sanitizeProjectDirectoryName('my:app?'), 'my_app_');
  assert.equal(sanitizeProjectDirectoryName('project.  '), 'project');
  assert.equal(sanitizeProjectDirectoryName('CON'), '_CON');
  assert.equal(sanitizeProjectDirectoryName('nul.txt'), '_nul.txt');
  assert.equal(sanitizeProjectDirectoryName('folder\\name'), 'folder_name');
  assert.throws(() => sanitizeProjectDirectoryName('...   '), /normal directory name/);
});


test('Create Project validates the session node before creating fallback filesystem state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-session-invalid-project-'));
  const workspace = path.join(root, 'source');
  const targetParent = path.join(root, 'projects');
  await fs.mkdir(path.join(workspace, '.pi', 'studio-sessions'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'index.js'), 'console.log("source")\n');
  const session = path.join(workspace, '.pi', 'studio-sessions', 'session.jsonl');
  await fs.writeFile(session, `${JSON.stringify({ id: 'root', type: 'session_header', cwd: workspace })}\n${JSON.stringify({ id: 'u1', parentId: 'root', message: { role: 'user', content: 'hello' } })}\n`);
  const target = path.join(targetParent, 'invalid-node-app');
  await assert.rejects(() => createProjectFromNode(workspace, session, 'missing-node', 'invalid-node-app', targetParent, { copyWorkspace: true }), /Session node not found/);
  await assert.rejects(() => fs.stat(target), (error) => error?.code === 'ENOENT');
});
