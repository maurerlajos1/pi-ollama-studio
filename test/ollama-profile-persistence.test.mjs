import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-ollama-profile-runtime-'));
const appDir = path.join(root, 'app');
const agentDir = path.join(root, 'agent');
await fs.mkdir(appDir, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
process.env.PI_OLLAMA_STUDIO_DIR = appDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const runtimeA = 'http://runtime-a.test:11434';
const runtimeB = 'http://runtime-b.test:11434';
const inventories = new Map([
  [runtimeA, new Set(['qwen:latest'])],
  [runtimeB, new Set(['qwen:latest'])]
]);

async function writeRuntime(baseUrl, name) {
  await fs.writeFile(path.join(appDir, 'runtime.json'), JSON.stringify({
    ollamaBaseUrl: baseUrl,
    ollamaRuntimeName: name,
    ollamaRuntimeKind: 'lan'
  }, null, 2));
}

await writeRuntime(runtimeA, 'Runtime A');

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  const runtime = href.startsWith(runtimeA) ? runtimeA : href.startsWith(runtimeB) ? runtimeB : '';
  if (!runtime) throw new Error(`Unexpected URL ${href}`);
  const models = inventories.get(runtime);
  if (href.endsWith('/api/version')) return Response.json({ version: '0.30.9-test' });
  if (href.endsWith('/api/tags')) return Response.json({ models: [...models].map((model) => ({ model, name: model })) });
  if (href.endsWith('/api/ps')) return Response.json({ models: [] });
  if (href.endsWith('/api/create')) {
    const body = JSON.parse(String(options.body || '{}'));
    const id = String(body.model || '').trim();
    if (id) models.add(id.includes(':') ? id : `${id}:latest`);
    return new Response(`${JSON.stringify({ status: 'success' })}\n`, { status: 200 });
  }
  if (href.endsWith('/api/delete')) {
    const body = JSON.parse(String(options.body || '{}'));
    const id = String(body.model || '').trim().toLowerCase();
    for (const model of [...models]) {
      const lower = model.toLowerCase();
      if (lower === id || lower === `${id}:latest` || (id.endsWith(':latest') && lower === id.slice(0, -7))) models.delete(model);
    }
    return Response.json({ ok: true });
  }
  throw new Error(`Unhandled URL ${href}`);
};

const ollama = await import('../src/ollama.mjs');

test.after(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(root, { recursive: true, force: true });
});

test('same profile ID can coexist on separate Ollama runtimes and current-runtime binding beats portable fallback', async () => {
  await ollama.createModelProfile({ name: 'shared', displayName: 'Shared A', baseModel: 'qwen:latest', contextWindow: 32768 });
  await writeRuntime(runtimeB, 'Runtime B');
  await ollama.createModelProfile({ name: 'shared', displayName: 'Shared B', baseModel: 'qwen:latest', contextWindow: 65536 });
  await ollama.createModelProfile({ name: 'shared', displayName: 'Portable Shared', baseModel: 'qwen:latest', portable: true, contextWindow: 16384 });

  const saved = await ollama.loadProfiles();
  const shared = saved.profiles.filter((profile) => profile.id === 'shared');
  assert.equal(shared.length, 3);
  assert.deepEqual(new Set(shared.map((profile) => profile.runtime?.baseUrl || 'portable')), new Set([runtimeA, runtimeB, 'portable']));

  await ollama.syncPiModels();
  const pi = JSON.parse(await fs.readFile(path.join(agentDir, 'models.json'), 'utf8'));
  const entry = pi.providers.ollama.models.find((model) => model.id === 'shared');
  assert.equal(entry.name, 'Shared B');
  assert.equal(entry.contextWindow, 65536);

  await ollama.deleteModel('shared');
  const afterDelete = (await ollama.loadProfiles()).profiles.filter((profile) => profile.id === 'shared');
  assert.equal(afterDelete.length, 2, 'endpoint-local delete must preserve portable and other-runtime profiles');
  assert.deepEqual(new Set(afterDelete.map((profile) => profile.runtime?.baseUrl || 'portable')), new Set([runtimeA, 'portable']));
});

test('derived profiles never contaminate their base model and preserve vision capability', async () => {
  await writeRuntime(runtimeB, 'Runtime B');
  await ollama.createModelProfile({
    name: 'coder64', displayName: 'Coder 64K', baseModel: 'qwen:latest',
    contextWindow: 65536, maxTokens: 12000, vision: true, reasoning: true
  });
  await ollama.syncPiModels();
  const pi = JSON.parse(await fs.readFile(path.join(agentDir, 'models.json'), 'utf8'));
  const qwen = pi.providers.ollama.models.find((model) => model.id === 'qwen:latest');
  const coder = pi.providers.ollama.models.find((model) => model.id === 'coder64');
  assert.equal(qwen.name, 'qwen:latest', 'base model must keep its own identity');
  assert.notEqual(qwen.maxTokens, 12000, 'base model must not inherit derived profile output limit');
  assert.equal(coder.name, 'Coder 64K');
  assert.deepEqual(coder.input, ['text', 'image']);
  assert.equal(coder.maxTokens, 12000);
});

test('reasoning toggles use exact model aliases and do not mutate overlapping/base-derived profiles', async () => {
  const profileFile = path.join(appDir, 'profiles.json');
  const existing = JSON.parse(await fs.readFile(profileFile, 'utf8'));
  existing.profiles.push(
    { id: 'foo', name: 'Foo', baseModel: 'qwen:latest', reasoning: true },
    { id: 'foobar', name: 'Foo Bar', baseModel: 'foo', reasoning: true },
    { id: 'nameless-derived', name: '', baseModel: 'foo', reasoning: true }
  );
  await fs.writeFile(profileFile, JSON.stringify(existing, null, 2));
  await ollama.setModelReasoning('foo:latest', false);
  const updated = JSON.parse(await fs.readFile(profileFile, 'utf8')).profiles;
  assert.equal(updated.find((profile) => profile.id === 'foo').reasoning, false);
  assert.equal(updated.find((profile) => profile.id === 'foobar').reasoning, true);
  assert.equal(updated.find((profile) => profile.id === 'nameless-derived').reasoning, true);
});
