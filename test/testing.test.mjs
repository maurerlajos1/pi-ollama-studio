import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverTests, discoverRunConfigurations, runTests } from '../src/testing.mjs';

test('Test Explorer discovers Node tests and npm run configurations and runs the project suite', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node test-runner.mjs', dev: 'node app.mjs' }
  }, null, 2));
  await fs.writeFile(path.join(root, 'app.mjs'), 'export const add = (a,b) => a+b;\n');
  await fs.writeFile(path.join(root, 'test-runner.mjs'), "import { add } from './app.mjs'; if (add(2,3) !== 5) process.exit(1); console.log('fixture tests passed');\n");
  await fs.writeFile(path.join(root, 'test', 'app.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../app.mjs'; test('add',()=>assert.equal(add(2,3),5));\n");
  await fs.mkdir(path.join(root, 'node_modules', 'fake'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'fake', 'ignored.test.js'), 'throw new Error("should not discover")');

  const discovery = await discoverTests(root);
  assert.equal(discovery.tests.length, 1);
  assert.equal(discovery.tests[0].path, 'test/app.test.mjs');
  assert.deepEqual(discovery.tests[0].cases.map((item) => item.name), ['add']);
  assert.equal(discovery.defaults.jsFramework, null);

  const configs = await discoverRunConfigurations(root);
  assert.deepEqual(configs.configurations.map((x) => x.script), ['test', 'dev']);

  const all = await runTests(root, { mode: 'all', timeoutMs: 30000 });
  assert.equal(all.passed, true, all.output);
  assert.match(all.output, /fixture tests passed/i);

  const one = await runTests(root, { target: 'test/app.test.mjs', timeoutMs: 30000 });
  assert.equal(one.passed, true, one.output);
  assert.match(one.command, /--test/);

  const individual = await runTests(root, { target: 'test/app.test.mjs', testName: 'add', timeoutMs: 30000 });
  assert.equal(individual.passed, true, individual.output);
  assert.equal(individual.testName, 'add');
  assert.match(individual.command, /test-name-pattern/);
});

test('Test Explorer rejects test paths outside the workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-tests-escape-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await assert.rejects(() => runTests(root, { target: '../outside.test.mjs' }), /escapes workspace/);
});


test('Test Explorer rejects symlinked test targets that resolve outside the workspace', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-tests-symlink-'));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside.test.mjs');
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.writeFile(outside, "throw new Error('outside test must never execute');\n");
  try {
    await fs.symlink(outside, path.join(root, 'escape.test.mjs'), 'file');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EISDIR') {
      t.skip('symlink creation is not permitted in this environment');
      return;
    }
    throw error;
  }
  await assert.rejects(() => runTests(root, { target: 'escape.test.mjs' }), /escapes workspace/);
});
