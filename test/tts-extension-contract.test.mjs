import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'extensions', 'pi-ollama-studio-tts.ts');

test('optional Pi TTS extension exposes a safe explicit tts_speak tool contract', async () => {
  const source = await fs.readFile(extensionPath, 'utf8');
  assert.match(source, /from ["']typebox["']/);
  assert.match(source, /name:\s*["']tts_speak["']/);
  assert.match(source, /text:\s*Type\.String/);
  assert.match(source, /voice:\s*Type\.Optional/);
  assert.match(source, /Type\.Literal\(["']wav["']\)/);
  assert.match(source, /\/api\/tts\/generate-artifact/);
  assert.match(source, /response_format:\s*format/);
  assert.match(source, /AbortSignal\.timeout\(120000\)/);
  assert.match(source, /PI_OLLAMA_STUDIO_TTS_URL/);
  assert.match(source, /loopback Studio server/);
  assert.match(source, /audioUrl:\s*artifact\.url/);
  assert.doesNotMatch(source, /arrayBuffer\(\)/);
  assert.doesNotMatch(source, /writeFile|mkdir|spawn|execFile/);
});
