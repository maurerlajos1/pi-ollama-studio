import test from 'node:test';
import assert from 'node:assert/strict';
import { readJsonStrict, runtimeEnvironmentOverrides, serializeMutation, studioLoopbackUrl, validateConfig, writeJsonAtomic } from '../src/config.mjs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('validateConfig normalizes numeric and boolean settings', () => {
  const value = validateConfig({
    port: '5000', defaultContextLength: '65536', numParallel: '2', maxLoadedModels: '1', maxQueue: '128',
    gpuOverheadBytes: '1024', flashAttention: 1, managedOllama: 0, kvCacheType: 'q8_0'
  });
  assert.equal(value.port, 5000);
  assert.equal(value.defaultContextLength, 65536);
  assert.equal(value.numParallel, 2);
  assert.equal(value.flashAttention, true);
  assert.equal(value.managedOllama, false);
  assert.equal(validateConfig({ noCloud: 0 }).noCloud, false);
});

test('Studio loopback URL remains reachable for IPv4 and IPv6 bindings', () => {
  assert.equal(studioLoopbackUrl({ bindHost: '127.0.0.1', port: 4173 }), 'http://127.0.0.1:4173');
  assert.equal(studioLoopbackUrl({ bindHost: '::1', port: 4173 }), 'http://[::1]:4173');
});

test('explicit launch environment overrides persisted runtime settings', () => {
  const overrides = runtimeEnvironmentOverrides({
    STUDIO_PORT: '5123',
    STUDIO_BIND_HOST: '::1',
    OLLAMA_BASE_URL: 'http://192.168.1.50:11434/',
    PI_COMMAND: 'custom-pi'
  });
  const value = validateConfig({
    port: 4173,
    bindHost: '127.0.0.1',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ...overrides
  });
  assert.equal(value.port, 5123);
  assert.equal(value.bindHost, '::1');
  assert.equal(value.ollamaBaseUrl, 'http://192.168.1.50:11434');
  assert.equal(value.piCommand, 'custom-pi');
});

test('validateConfig rejects invalid KV cache type', () => {
  assert.throws(() => validateConfig({ kvCacheType: 'int2' }), /Invalid KV cache type/);
});

test('validateConfig keeps the code-execution server loopback-only', () => {
  assert.throws(() => validateConfig({ bindHost: '0.0.0.0' }), /may only bind/);
  assert.equal(validateConfig({ bindHost: '::1' }).bindHost, '::1');
});

test('validateConfig validates Ollama keep-alive durations', () => {
  assert.equal(validateConfig({ keepAlive: '1h' }).keepAlive, '1h');
  assert.throws(() => validateConfig({ keepAlive: 'forever please' }), /keepAlive/);
});


test('validateConfig accepts remote Ollama runtime profiles and validates API-key env names', () => {
  const value = validateConfig({
    ollamaBaseUrl: 'http://192.168.1.50:11434/',
    ollamaRuntimeKind: 'lan',
    ollamaRuntimeName: 'Office 3090',
    ollamaApiKeyEnv: 'OLLAMA_API_KEY'
  });
  assert.equal(value.ollamaBaseUrl, 'http://192.168.1.50:11434');
  assert.equal(value.ollamaRuntimeKind, 'lan');
  assert.equal(value.ollamaRuntimeName, 'Office 3090');
  assert.equal(value.ollamaApiKeyEnv, 'OLLAMA_API_KEY');
  assert.throws(() => validateConfig({ ollamaRuntimeKind: 'satellite' }), /runtime kind/i);
  assert.throws(() => validateConfig({ ollamaApiKeyEnv: 'bad env name' }), /environment variable/i);
});


test('writeJsonAtomic cleans its temporary file when the final rename fails', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-atomic-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const targetDirectory = path.join(dir, 'target.json');
  await fs.mkdir(targetDirectory);
  await assert.rejects(() => writeJsonAtomic(targetDirectory, { value: 1 }));
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'failed atomic writes must not leave temporary files behind');
});

test('serializeMutation orders concurrent read-modify-write operations per file', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-studio-mutation-lock-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json');await fs.writeFile(file,JSON.stringify({a:0,b:0}));
  const mutate=(key)=>serializeMutation(file,async()=>{const value=JSON.parse(await fs.readFile(file,'utf8'));await new Promise((resolve)=>setTimeout(resolve,10));value[key]+=1;await writeJsonAtomic(file,value);});
  await Promise.all([mutate('a'),mutate('b')]);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{a:1,b:1});
});


test('readJsonStrict rejects corrupt JSON without changing the original file', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-studio-corrupt-json-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'state.json');const raw='{"keep": true, BROKEN';await fs.writeFile(file,raw);
  await assert.rejects(()=>readJsonStrict(file,{}),(error)=>error?.code==='JSON_STORE_CORRUPT'&&error?.statusCode===409);
  assert.equal(await fs.readFile(file,'utf8'),raw);
});
