import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferManager, RegisterStore, SemanticMacroRecorder } from '../public/workbench.js';

test('BufferManager opens, dirties, saves and cycles buffers', () => {
  const manager = new BufferManager();
  manager.open({ path: 'src/a.js', content: 'a' });
  manager.open({ path: 'src/b.js', content: 'b' });
  assert.equal(manager.size, 2);
  assert.equal(manager.activeBuffer.path, 'src/b.js');
  manager.updateContent('changed');
  assert.equal(manager.activeBuffer.dirty, true);
  manager.markSaved();
  assert.equal(manager.activeBuffer.dirty, false);
  manager.next(-1);
  assert.equal(manager.activeBuffer.path, 'src/a.js');
});

test('BufferManager supports independent split panes', () => {
  const manager = new BufferManager();
  manager.open({ path: 'a.txt', content: 'A' });
  manager.open({ path: 'b.txt', content: 'B' });
  manager.activate('a.txt');
  manager.setSplit('vertical');
  manager.activate('b.txt', { paneId: 'secondary' });
  assert.equal(manager.bufferForPane('primary').path, 'a.txt');
  assert.equal(manager.bufferForPane('secondary').path, 'b.txt');
  assert.equal(manager.split, 'vertical');
  manager.closeSplit();
  assert.equal(manager.split, 'none');
});

test('BufferManager protects dirty buffers from accidental close', () => {
  const manager = new BufferManager();
  manager.open({ path: 'a.txt', content: 'A' });
  manager.updateContent('AA');
  assert.equal(manager.close('a.txt').reason, 'dirty');
  assert.equal(manager.close('a.txt', { force: true }).closed, true);
});

test('RegisterStore keeps named and unnamed register values', () => {
  const registers = new RegisterStore();
  registers.set('a', 'hello', { type: 'message', label: 'Assistant response' });
  assert.equal(registers.get('a').value, 'hello');
  assert.equal(registers.get('"').value, 'hello');
});

test('SemanticMacroRecorder records semantic commands and replays in order', async () => {
  const macros = new SemanticMacroRecorder();
  const calls = [];
  macros.start('q');
  macros.record('view.git', []);
  macros.record('problems.next', [1]);
  macros.stop();
  const count = await macros.replay('q', async (id, ...args) => calls.push([id, ...args]));
  assert.equal(count, 2);
  assert.deepEqual(calls, [['view.git'], ['problems.next', 1]]);
});


test('BufferManager treats fresh file reload content as clean', () => {
  const manager = new BufferManager();
  manager.open({ path: 'a.txt', content: 'A' });
  manager.updateContent('dirty');
  assert.equal(manager.activeBuffer.dirty, true);
  manager.open({ path: 'a.txt', content: 'A2' });
  assert.equal(manager.activeBuffer.content, 'A2');
  assert.equal(manager.activeBuffer.original, 'A2');
  assert.equal(manager.activeBuffer.dirty, false);
});


test('BufferManager can mark a background dirty buffer saved without changing the active pane', () => {
  const manager = new BufferManager();
  manager.open({ path: 'a.txt', content: 'A' });
  manager.updateContent('AA');
  manager.open({ path: 'b.txt', content: 'B' });
  assert.equal(manager.activeBuffer.path, 'b.txt');
  const saved = manager.markBufferSaved('a.txt', { content: 'AA', size: 2 });
  assert.equal(saved.dirty, false);
  assert.equal(saved.original, 'AA');
  assert.equal(manager.activeBuffer.path, 'b.txt');
});


test('BufferManager reloads clean buffers from disk but flags dirty buffers as external conflicts', () => {
  const manager = new BufferManager();
  manager.open({ path: 'src/a.js', content: 'one', mtimeMs: 1000 });
  let result = manager.refreshFromDisk('src/a.js', { content: 'two', size: 3, mtimeMs: 2000, modifiedAt: '2026-08-07T00:00:00.000Z' });
  assert.equal(result.action, 'reloaded');
  assert.equal(manager.buffer('src/a.js').content, 'two');
  assert.equal(manager.buffer('src/a.js').dirty, false);
  assert.equal(manager.buffer('src/a.js').mtimeMs, 2000);

  manager.updateContent('my unsaved edit');
  result = manager.refreshFromDisk('src/a.js', { content: 'agent edit', size: 10, mtimeMs: 3000 });
  assert.equal(result.action, 'conflict');
  assert.equal(manager.buffer('src/a.js').content, 'my unsaved edit');
  assert.equal(manager.buffer('src/a.js').externalChanged, true);
  assert.equal(manager.buffer('src/a.js').externalMtimeMs, 3000);
});
