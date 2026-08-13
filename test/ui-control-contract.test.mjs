import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const html = await fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8');
const frontendFiles = (await fs.readdir(PUBLIC)).filter((name) => name.endsWith('.js'));
const frontendSource = (await Promise.all(frontendFiles.map((name) => fs.readFile(path.join(PUBLIC, name), 'utf8')))).join('\n');

function attributes(text) {
  return Object.fromEntries([...String(text).matchAll(/([:\w-]+)(?:="([^"]*)")?/g)].map((match) => [match[1].toLowerCase(), match[2] ?? '']));
}

function controls() {
  return [...html.matchAll(/<(button|input|select|textarea|a)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gi)]
    .map((match) => ({ tag: match[1].toLowerCase(), attrs: attributes(match[2]), body: String(match[3] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
    .filter((control) => control.attrs.type !== 'hidden');
}

test('every static interactive id is unique and connected to frontend behavior', () => {
  const withId = controls().filter((control) => control.attrs.id);
  const seen = new Set();
  for (const control of withId) {
    assert.equal(seen.has(control.attrs.id), false, `Duplicate interactive id: ${control.attrs.id}`);
    seen.add(control.attrs.id);
    const id = control.attrs.id;
    const referenced = frontendSource.includes(`#${id}`) || frontendSource.includes(`'${id}'`) || frontendSource.includes(`"${id}"`);
    assert.equal(referenced, true, `Interactive control #${id} is not referenced by any frontend module`);
  }
  assert.ok(withId.length >= 250, `Unexpectedly small UI control surface: ${withId.length}`);
});

test('static controls have an accessible or visible name', () => {
  for (const control of controls()) {
    if (control.tag === 'input' && ['checkbox', 'radio'].includes(control.attrs.type)) continue;
    const named = control.body || control.attrs['aria-label'] || control.attrs.title || control.attrs.placeholder || control.attrs.id;
    assert.ok(named, `Unnamed interactive control: <${control.tag} ${JSON.stringify(control.attrs)}>`);
  }
});

test('all id-less static controls use a delegated action contract', () => {
  const idless = controls().filter((control) => !control.attrs.id);
  const permitted = /^(data-view|data-prompt|data-mode|data-filter|data-platform-tab|data-resource-filter|data-doc-link|data-doc-action|data-settings|data-harness-tool)$/;
  for (const control of idless) {
    const harnessToolChoice = control.tag === 'input' && control.attrs.type === 'checkbox' && Boolean(control.attrs.value);
    assert.ok(harnessToolChoice || Object.keys(control.attrs).some((name) => permitted.test(name)), `Id-less control has no delegated action attribute: ${JSON.stringify(control)}`);
  }
});

test('session list has one authoritative renderer with Fork and Clone actions', () => {
  assert.equal((frontendSource.match(/function renderSessions\s*\(/g) || []).length, 1);
  assert.equal(frontendSource.includes('function renderSessionsList('), false);
  assert.equal(frontendSource.includes('function loadWorkspaceSessions('), false);
  assert.match(frontendSource, /class="sm-btn ghost fork-btn"/);
  assert.match(frontendSource, /class="sm-btn ghost clone-btn"/);
});

test('recent-project Open and Remove controls keep distinct handlers', () => {
  assert.match(frontendSource, /\$\('\.recent-project-main', row\)\.onclick = async \(\) =>/);
  assert.match(frontendSource, /\$\('\.sm-btn', row\)\.onclick = \(\) =>/);
  assert.doesNotMatch(frontendSource, /\$\('button', row\)\.onclick = \(\) =>/);
});
