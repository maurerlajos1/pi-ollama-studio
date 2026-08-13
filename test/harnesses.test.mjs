import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeHarnessSystemPrompt, listHarnesses, resolveHarness, saveHarness, deleteHarness } from '../src/harnesses.mjs';

test('built-in harnesses separate normal Pi, web-enabled Pi, local-focused coding, and read-only review contracts', async () => {
  const { harnesses } = await listHarnesses();
  assert.deepEqual(harnesses.slice(0, 4).map((item) => item.id), ['coding-default', 'coding-web', 'local-focused', 'review-readonly']);
  assert.equal(harnesses.find((item) => item.id === 'coding-web')?.name, 'Coding · Pi Default + Web');
  assert.equal((await resolveHarness('coding-default')).tools, null);
  assert.deepEqual((await resolveHarness('review-readonly')).tools, ['read', 'grep', 'find', 'ls']);
  assert.ok((await resolveHarness('local-focused')).appendSystemPrompt.includes('inspect'));
  await assert.rejects(() => resolveHarness('does-not-exist'), (error) => error?.code === 'HARNESS_NOT_FOUND' && error?.statusCode === 400);
});

test('web harness receives the actual runtime date and newest-first current-news guidance', async () => {
  const harness = await resolveHarness('coding-web');
  const prompt = composeHarnessSystemPrompt(harness, { now: new Date('2026-08-09T12:00:00Z') });
  assert.match(prompt, /Current date: 2026-08-09/);
  assert.match(prompt, /never inject a stale year/i);
  assert.match(prompt, /newest-first/i);
  assert.doesNotMatch(prompt, /2025/);
  assert.equal(composeHarnessSystemPrompt(await resolveHarness('coding-default'), { now: new Date('2026-08-09T12:00:00Z') }), '');
});

test('project harness manifests are saveable, reusable, inspectable files and deletable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-harness-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const saved = await saveHarness({
    workspace: root,
    scope: 'project',
    harness: {
      name: 'Frontend Bug Fixer',
      kind: 'coding',
      description: 'Small bounded frontend fixes',
      tools: ['read', 'grep', 'edit', 'bash'],
      appendSystemPrompt: 'Inspect first. Verify after edits.'
    }
  });
  assert.equal(saved.id, 'frontend-bug-fixer');
  assert.equal(saved.scope, 'project');
  assert.equal(path.basename(saved.file), 'frontend-bug-fixer.json');
  assert.equal(path.basename(path.dirname(saved.file)), 'harnesses');
  assert.equal(path.basename(path.dirname(path.dirname(saved.file))), '.pi');
  const onDisk = JSON.parse(await fs.readFile(saved.file, 'utf8'));
  assert.equal(onDisk.name, 'Frontend Bug Fixer');
  assert.deepEqual(onDisk.tools, ['read', 'grep', 'edit', 'bash']);
  const listed = await listHarnesses({ workspace: root });
  assert.ok(listed.harnesses.some((item) => item.id === saved.id && item.scope === 'project'));
  const resolved = await resolveHarness(saved.id, { workspace: root });
  assert.equal(resolved.appendSystemPrompt, 'Inspect first. Verify after edits.');
  await deleteHarness({ workspace: root, scope: 'project', id: saved.id });
  const after = await listHarnesses({ workspace: root });
  assert.ok(!after.harnesses.some((item) => item.id === saved.id));
});

test('a corrupt custom harness manifest is reported and cannot be silently overwritten', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-harness-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.pi', 'harnesses');
  const file = path.join(dir, 'broken.json');
  await fs.mkdir(dir, { recursive: true });
  const original = '{ definitely not json';
  await fs.writeFile(file, original, 'utf8');
  const listed = await listHarnesses({ workspace: root });
  assert.equal(listed.errors.length, 1);
  await assert.rejects(() => saveHarness({ workspace: root, scope: 'project', harness: { id: 'broken', name: 'Broken', tools: ['read'] } }), (error) => error?.code === 'JSON_STORE_CORRUPT' && error?.statusCode === 409);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('in-app session launcher exposes workspace/runtime/model/harness explicitly and never treats GPU residency as model selection', async () => {
  const [html, app] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="topHarness"/);
  assert.match(html, /id="sessionLauncherModal"/);
  assert.match(html, /id="sessionLaunchModelState"/);
  assert.match(html, /id="harnessBuilderModal"/);
  assert.match(html, /id="harnessSaveEffective"/);
  assert.match(html, /GPU residency is shown for speed, but never changes your selected model/);
  assert.match(app, /function openSessionLauncher/);
  assert.match(app, /runningOllamaModel/);
  assert.match(app, /GPU model is only a performance hint|currently loaded GPU model is only a performance hint/);
  assert.match(app, /harnessId/);
  assert.match(app, /function openHarnessBuilder/);
  assert.match(app, /function loadHarnesses/);
});
