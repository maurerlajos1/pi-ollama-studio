import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry, fuzzyScore, rankCommands } from '../public/command-system.js';

test('CommandRegistry registers, filters and executes semantic commands', async () => {
  const registry = new CommandRegistry();
  let ran = false;
  registry.register({ id: 'agent.test', title: 'Run test', category: 'Agent', execute: async () => { ran = true; } });
  registry.register({ id: 'hidden', title: 'Hidden', execute: () => {}, isAvailable: () => false });
  assert.equal(registry.list({}).length, 1);
  await registry.execute('agent.test', {});
  assert.equal(ran, true);
});

test('fuzzy command ranking favors direct and exact matches', () => {
  assert.ok(fuzzyScore('git', 'Git status') > fuzzyScore('git', 'Agent compact'));
  const ranked = rankCommands([
    { id: 'agent.compact', title: 'Compact context', category: 'Agent' },
    { id: 'git.status', title: 'Git status', category: 'Git' }
  ], 'git');
  assert.equal(ranked[0].command.id, 'git.status');
});
