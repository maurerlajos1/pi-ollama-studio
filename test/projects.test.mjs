import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewProject } from '../src/system.mjs';

test('New Project creates plain HTML and Node workspaces transactionally under the selected parent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-project-wizard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const html = await createNewProject(root, 'demo-html', 'html');
  assert.equal(html.workspacePath, path.join(root, 'demo-html'));
  assert.deepEqual(html.files, ['AGENTS.md', 'index.html', 'styles.css', 'script.js']);
  assert.match(await fs.readFile(path.join(html.workspacePath, 'index.html'), 'utf8'), /demo-html/);
  const node = await createNewProject(root, 'demo-node', 'node');
  const pkg = JSON.parse(await fs.readFile(path.join(node.workspacePath, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(await fs.readFile(path.join(node.workspacePath, 'src', 'index.mjs'), 'utf8').then((v) => v.includes('demo-node')), true);
});

test('New Project refuses an existing target instead of merging into it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-project-existing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'existing');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'keep.txt'), 'keep me', 'utf8');
  await assert.rejects(() => createNewProject(root, 'existing', 'html'), (error) => error?.code === 'PROJECT_EXISTS' && error?.statusCode === 409);
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'keep me');
  assert.deepEqual(await fs.readdir(target), ['keep.txt']);
});

test('project UI exposes New/Open/Recent and session-derived destination selection without browser prompt()', async () => {
  const [html, app] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="projectManagerModal"/);
  assert.match(html, /id="projectWizardModal"/);
  assert.match(html, /id="projectWizardBrowse"/);
  assert.match(html, /id="recentProjectList"/);
  assert.match(html, /id="newProject"[^>]+aria-label="New project"/);
  assert.match(html, /id="newSession"[^>]+aria-label="New Pi session"/);
  assert.match(html, /id="selectFolder"[^>]+aria-label="Browse for project folder"/);
  assert.match(app, /function openNewProjectWizard/);
  assert.match(app, /function openProjectFromSessionWizard/);
  assert.match(app, /parentDir/);
  const createFromNode = app.match(/function promptCreateAppFromNode[\s\S]*?\n}/)?.[0] || '';
  assert.doesNotMatch(createFromNode, /prompt\(/);
});
