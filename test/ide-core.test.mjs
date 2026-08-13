import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, searchWorkspace, gitInitializeRepository, getGitStatus, gitStage, gitCommit, gitReadFileVersion, gitRestoreFile, createDirectory, managedOllamaEnvironment } from '../src/system.mjs';
import { languageForPath, MonacoDiffAdapter } from '../public/monaco-adapter.js';
import { mergeDiagnostics, normalizeDiagnostic, parseTextDiagnostics } from '../public/diagnostics.js';
import { WorkspaceStateStore } from '../public/workbench.js';

test('languageForPath maps common coding files without guessing unknown types', () => {
  assert.equal(languageForPath('src/app.ts'), 'typescript');
  assert.equal(languageForPath('src/view.jsx'), 'javascript');
  assert.equal(languageForPath('Dockerfile'), 'dockerfile');
  assert.equal(languageForPath('config.yaml'), 'yaml');
  assert.equal(languageForPath('blob.unknown'), 'plaintext');
});

test('Monaco diff models are detached before replacement or disposal', () => {
  const events = [];
  let attached = null;
  let sequence = 0;
  const makeModel = (label) => ({
    label,
    dispose() {
      assert.equal(attached?.original === this || attached?.modified === this, false, `${label} was disposed while attached`);
      events.push(`dispose:${label}`);
    }
  });
  const adapter = new MonacoDiffAdapter();
  adapter.editor = {
    setModel(value) { attached = value; events.push(value ? 'attach' : 'detach'); },
    dispose() { assert.equal(attached, null); events.push('dispose:editor'); }
  };
  adapter.monaco = {
    Uri: { parse: (value) => value },
    editor: { createModel: () => makeModel(`model-${++sequence}`) }
  };

  adapter.setDiff({ path: 'src/app.js', original: 'one', modified: 'two' });
  adapter.setDiff({ path: 'src/app.js', original: 'three', modified: 'four' });
  assert.deepEqual(events.slice(2, 6), ['detach', 'dispose:model-1', 'dispose:model-2', 'attach']);

  adapter.dispose();
  assert.deepEqual(events.slice(-4), ['detach', 'dispose:editor', 'dispose:model-3', 'dispose:model-4']);
});

test('WorkspaceStateStore round-trips bounded layout state and rejects wrong versions', () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) || null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const store = new WorkspaceStateStore(storage);
  assert.equal(store.save('/repo', { openPaths: ['a.js', 'b.js', 'a.js'], split: 'vertical', activePane: 'secondary', panePaths: { primary: 'a.js', secondary: 'b.js' }, splitSize: 74, activeView: 'editor' }), true);
  const restored = store.load('/repo');
  assert.deepEqual(restored.openPaths, ['a.js', 'b.js']);
  assert.equal(restored.split, 'vertical');
  assert.equal(restored.activePane, 'secondary');
  assert.equal(restored.splitSize, 74);
  map.set(store.key('/repo'), JSON.stringify({ version: 999, openPaths: [] }));
  assert.equal(store.load('/repo'), null);
});

test('diagnostics parser normalizes common compiler formats and deduplicates', () => {
  const parsed = parseTextDiagnostics('src/a.ts:12:4 error: broken\nsrc/b.ts(3,9): warning TS1001: careful', { source: 'test' });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].path, 'src/a.ts');
  assert.equal(parsed[0].severity, 'error');
  assert.equal(parsed[1].severity, 'warning');
  const merged = mergeDiagnostics(parsed[0], normalizeDiagnostic(parsed[0]));
  assert.equal(merged.length, 1);
});

test('workspace search skips ignored/binary files and returns line/column matches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'const hello = 1;\n// HELLO again\n');
  await fs.writeFile(path.join(root, 'node_modules', 'ignored', 'x.js'), 'hello');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3, 4]));
  const result = await searchWorkspace(root, 'hello');
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].path, 'src/a.js');
  assert.deepEqual(result.matches.map((m) => m.line), [1, 2]);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.skippedFiles, 1);
});

test('Git IDE helpers expose HEAD/index versions and safely restore tracked files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-git-ide-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = async (...args) => runCommand('git', args, { cwd: root, env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  assert.equal((await git('init')).code, 0);
  await fs.writeFile(path.join(root, 'a.txt'), 'one\n');
  assert.equal((await git('add', 'a.txt')).code, 0);
  assert.equal((await git('commit', '-m', 'initial')).code, 0);
  await fs.writeFile(path.join(root, 'a.txt'), 'two\n');
  const head = await gitReadFileVersion(root, 'a.txt', 'head');
  assert.equal(head.content, 'one\n');
  assert.equal((await git('add', 'a.txt')).code, 0);
  const index = await gitReadFileVersion(root, 'a.txt', 'index');
  assert.equal(index.content, 'two\n');
  await fs.writeFile(path.join(root, 'a.txt'), 'three\n');
  await gitRestoreFile(root, 'a.txt');
  assert.equal((await fs.readFile(path.join(root, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'two\n');
  await fs.writeFile(path.join(root, 'new.txt'), 'new\n');
  await assert.rejects(() => gitRestoreFile(root, 'new.txt'), /untracked file/i);
});


test('vendored Monaco 0.55.1 contains the AMD loader, editor entrypoint, CSS and referenced worker assets', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const monacoRoot = path.join(root, 'vendor', 'monaco');
  const pkg = JSON.parse(await fs.readFile(path.join(monacoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.55.1');
  const loader = await fs.readFile(path.join(monacoRoot, 'vs', 'loader.js'), 'utf8');
  const main = await fs.readFile(path.join(monacoRoot, 'vs', 'editor', 'editor.main.js'), 'utf8');
  assert.match(loader, /AMDLoader/);
  assert.match(main, /vs\/editor\/editor.main/);
  assert.equal((await fs.stat(path.join(monacoRoot, 'vs', 'editor', 'editor.main.css'))).isFile(), true);
  const referencedWorkers = [...main.matchAll(/\.\.\/assets\/([^"')]+worker[^"')]+\.js)/g)].map((m) => m[1]);
  assert.ok(referencedWorkers.length >= 5, 'expected editor/json/css/html/typescript worker assets');
  for (const worker of new Set(referencedWorkers)) {
    assert.equal((await fs.stat(path.join(monacoRoot, 'vs', 'assets', worker))).isFile(), true, `missing Monaco worker ${worker}`);
  }
});

test('Monaco LSP provider registrations match the vendored 0.55.1 standalone API', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const client = await fs.readFile(path.join(root, 'public', 'lsp-client.js'), 'utf8');
  const declaration = await fs.readFile(path.join(root, 'vendor', 'monaco', 'monaco.d.ts'), 'utf8');
  const registrations = [...client.matchAll(/m\.languages\.(register[A-Za-z]+Provider)\(/g)].map((match) => match[1]);
  assert.ok(registrations.length >= 8, 'expected the LSP bridge to register language providers');
  for (const name of new Set(registrations)) {
    assert.match(declaration, new RegExp(`function ${name}\\(`), `${name} is not part of Monaco 0.55.1 standalone API`);
  }
  assert.doesNotMatch(client, /registerWorkspaceSymbolProvider/, 'Monaco standalone has no workspace-symbol provider registration API');
});


test('Git onboarding initializes a non-repository, creates a safe .gitignore and baseline commit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-git-init-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'console.log("hello");\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=do-not-commit\n');

  const result = await gitInitializeRepository(root);
  assert.equal(result.initialized, true);
  assert.equal(result.initializedNow, true);
  assert.equal(result.gitignoreCreated, true);
  assert.equal(result.baselineCreated, true);
  assert.ok(/^[0-9a-f]{40}$/i.test(result.baselineCommit));

  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m);
  const tracked = await runCommand('git', ['ls-files'], { cwd: root });
  assert.match(tracked.stdout, /src\/main\.js/);
  assert.doesNotMatch(tracked.stdout, /(?:^|\n)\.env(?:\n|$)/);
  const status = await getGitStatus(root);
  assert.equal(status.isRepository, true);
  assert.equal(status.branch, 'main');
});

test('Git onboarding never overwrites an existing .gitignore and gates sensitive baseline files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-git-sensitive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const existingIgnore = 'node_modules/\n';
  await fs.writeFile(path.join(root, '.gitignore'), existingIgnore);
  await fs.writeFile(path.join(root, 'private.key'), 'secret\n');
  await fs.writeFile(path.join(root, 'app.js'), 'export const ready = true;\n');

  const first = await gitInitializeRepository(root, { createGitignore: true, createBaseline: true });
  assert.equal(first.initialized, true);
  assert.equal(first.gitignoreCreated, false);
  assert.equal(first.baselineCreated, false);
  assert.equal(first.requiresSensitiveConfirmation, true);
  assert.ok(first.sensitiveFiles.includes('private.key'));
  assert.equal(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), existingIgnore);

  const confirmed = await gitInitializeRepository(root, { createGitignore: true, createBaseline: true, confirmSensitive: true });
  assert.equal(confirmed.initializedNow, false);
  assert.equal(confirmed.baselineCreated, true);
  const tracked = await runCommand('git', ['ls-files'], { cwd: root });
  assert.match(tracked.stdout, /private\.key/);
});

test('editor pane activation does not re-render Monaco and cursor/view changes are persisted independently', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const appSource = await fs.readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const adapterSource = await fs.readFile(path.join(root, 'public', 'monaco-adapter.js'), 'utf8');

  const activateMatch = appSource.match(/function activateWorkbenchPane\([\s\S]*?\n}\n\nfunction updateWorkbenchStatus/);
  assert.ok(activateMatch, 'activateWorkbenchPane helper is missing');
  assert.doesNotMatch(activateMatch[0], /renderWorkbench\s*\(/, 'pane activation must not re-render Monaco');
  assert.doesNotMatch(activateMatch[0], /renderPane\s*\(/, 'pane activation must not restore Monaco view state');

  const bindMatch = appSource.match(/function bindEditorPane\([\s\S]*?\n}\nbindEditorPane\('primary'\)/);
  assert.ok(bindMatch, 'bindEditorPane helper is missing');
  assert.match(bindMatch[0], /mousedown[^\n]*activateWorkbenchPane/, 'mouse activation should update pane chrome without full rendering');
  assert.doesNotMatch(bindMatch[0], /mousedown[^\n]*renderWorkbench/, 'mousedown must not call renderWorkbench');

  assert.match(adapterSource, /onDidChangeCursorPosition\(\(\) => this\.onViewStateChanged\(paneId\)\)/);
  assert.match(adapterSource, /onDidChangeCursorSelection\(\(\) => this\.onViewStateChanged\(paneId\)\)/);
  assert.match(adapterSource, /onDidScrollChange\(\(\) => this\.onViewStateChanged\(paneId\)\)/);
});


test('managed Ollama environment follows the configured local endpoint and never invents a machine-specific model directory', () => {
  const env = managedOllamaEnvironment({
    ollamaBaseUrl: 'http://192.168.0.20:11434', flashAttention: true, kvCacheType: 'q8_0',
    defaultContextLength: 65536, numParallel: 1, maxLoadedModels: 1, maxQueue: 64,
    keepAlive: '30m', noCloud: true
  }, { PATH: 'x' });
  assert.equal(env.OLLAMA_HOST, '192.168.0.20:11434');
  assert.equal(env.OLLAMA_MODELS, undefined);
  const custom = managedOllamaEnvironment({ ollamaBaseUrl: 'http://127.0.0.1:11435' }, { OLLAMA_MODELS: '/models' });
  assert.equal(custom.OLLAMA_HOST, '127.0.0.1:11435');
  assert.equal(custom.OLLAMA_MODELS, '/models');
});

test('directory creation rejects dot path aliases while preserving normal arbitrary filesystem folder names', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-mkdir-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await createDirectory(root, '..')).ok, false);
  const created = await createDirectory(root, 'project & experiments');
  assert.equal(created.ok, true);
  assert.equal((await fs.stat(created.path)).isDirectory(), true);
});

test('Git status preserves filenames with spaces and rename source/destination paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-git-status-z-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = async (...args) => runCommand('git', args, { cwd: root, env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  assert.equal((await git('init')).code, 0);
  await fs.writeFile(path.join(root, 'old file.txt'), 'one\n');
  assert.equal((await git('add', 'old file.txt')).code, 0);
  assert.equal((await git('commit', '-m', 'initial')).code, 0);
  assert.equal((await git('mv', 'old file.txt', 'new file.txt')).code, 0);
  await fs.writeFile(path.join(root, 'another file.txt'), 'new\n');

  const status = await getGitStatus(root);
  const renamed = status.files.find((entry) => entry.xy.includes('R'));
  assert.equal(renamed.file, 'new file.txt');
  assert.equal(renamed.originalPath, 'old file.txt');
  assert.equal(renamed.staged, true);
  const untracked = status.files.find((entry) => entry.file === 'another file.txt');
  assert.ok(untracked);
  assert.equal(untracked.xy, '??');
});

test('Git operations scope a nested workspace to its own subtree', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-git-subtree-'));
  const workspace = path.join(root, 'project');
  const sibling = path.join(root, 'sibling');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  const git = async (...args) => runCommand('git', args, { cwd: root, env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  assert.equal((await git('init')).code, 0);
  await fs.writeFile(path.join(workspace, 'tracked.txt'), 'baseline\n');
  await fs.writeFile(path.join(sibling, 'tracked.txt'), 'sibling baseline\n');
  assert.equal((await git('add', '.')).code, 0);
  assert.equal((await git('commit', '-m', 'baseline')).code, 0);
  await fs.writeFile(path.join(workspace, 'tracked.txt'), 'workspace change\n');
  await fs.writeFile(path.join(workspace, 'inside.txt'), 'inside\n');
  await fs.writeFile(path.join(sibling, 'outside.txt'), 'outside\n');

  const status = await getGitStatus(workspace);
  assert.equal(status.isRepository, true);
  assert.equal(status.workspacePrefix, 'project');
  assert.ok(status.files.some((entry) => entry.file === 'inside.txt'));
  assert.ok(status.files.some((entry) => entry.file === 'tracked.txt'));
  assert.equal(status.files.some((entry) => entry.file.includes('sibling') || entry.file.includes('project/')), false);
  assert.doesNotMatch(status.status, /sibling|project\//);

  await gitStage(workspace, '.', true, true);
  const staged = await git('diff', '--cached', '--name-only');
  assert.match(staged.stdout, /project\/inside\.txt/);
  assert.doesNotMatch(staged.stdout, /sibling\/outside\.txt/);
  assert.equal((await gitReadFileVersion(workspace, 'tracked.txt', 'head')).content, 'baseline\n');

  await fs.writeFile(path.join(sibling, 'tracked.txt'), 'sibling staged change\n');
  assert.equal((await git('add', 'sibling/tracked.txt')).code, 0);
  await assert.rejects(() => gitCommit(workspace, 'must stay scoped'), /outside the selected workspace/);
});
