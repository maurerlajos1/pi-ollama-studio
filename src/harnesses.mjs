import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_DIR, canonicalWorkspacePath, readJsonStrict, serializeMutation, writeJsonAtomic } from './config.mjs';

const BUILTIN_HARNESSES = Object.freeze([
  Object.freeze({
    id: 'coding-default',
    name: 'Coding · Pi Default',
    kind: 'coding',
    description: 'Normal Pi coding behavior with project/global extensions, skills, prompts, context files, and the default tool surface.',
    tools: null,
    appendSystemPrompt: '',
    source: 'builtin',
    editable: false
  }),
  Object.freeze({
    id: 'coding-web',
    name: 'Coding · Pi Default + Web',
    kind: 'coding',
    description: 'Normal Pi coding behavior plus enabled web-search/fetch extension tools when they are installed in the active Pi resource set.',
    tools: null,
    appendSystemPrompt: [
      'Web-enabled coding harness guidance:',
      '- Use web-search or web-fetch tools only when they are available in the active Pi session.',
      '- Prefer authoritative primary sources and inspect fetched content before relying on it.',
      '- Keep web research bounded and return the relevant evidence to the coding task.',
      '- If the web tools are unavailable, continue with local project resources and say so clearly.'
    ].join('\n'),
    source: 'builtin',
    editable: false
  }),
  Object.freeze({
    id: 'local-focused',
    name: 'Small Local Coder',
    kind: 'coding',
    description: 'A bounded built-in tool surface and staged inspect → edit → verify workflow for smaller/local coding models.',
    tools: Object.freeze(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']),
    appendSystemPrompt: [
      'Local coding harness guidance:',
      '- Inspect the relevant files and repository structure before editing.',
      '- Work in small, coherent steps; do not broaden scope unless necessary.',
      '- Prefer read/grep/find/ls for discovery instead of shell-only exploration.',
      '- After changing code, run the smallest relevant verification and inspect failures before retrying.',
      '- Do not repeat an unchanged failed tool call; use the error to adjust the next action.'
    ].join('\n'),
    source: 'builtin',
    editable: false
  }),
  Object.freeze({
    id: 'review-readonly',
    name: 'Read-only Review',
    kind: 'agent',
    description: 'Repository analysis with only read/search tools. No file mutation or shell execution is exposed to the model.',
    tools: Object.freeze(['read', 'grep', 'find', 'ls']),
    appendSystemPrompt: [
      'Read-only review harness:',
      '- Inspect and analyze the repository without modifying files.',
      '- Identify correctness, regression, maintainability, performance, and security risks with concrete file references.',
      '- Do not claim a fix was applied; recommend the smallest safe changes instead.'
    ].join('\n'),
    source: 'builtin',
    editable: false
  })
]);

const BUILTIN_BY_ID = new Map(BUILTIN_HARNESSES.map((harness) => [harness.id, harness]));
const GLOBAL_HARNESS_DIR = path.join(APP_DIR, 'harnesses');
const CORE_TOOL_ORDER = Object.freeze(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);

function cloneHarness(harness) {
  return { ...harness, tools: harness.tools ? [...harness.tools] : null };
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeTools(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw Object.assign(new Error('Harness tools must be an array or null'), { statusCode: 400, code: 'HARNESS_INVALID' });
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const tool = String(raw || '').trim();
    if (!tool) continue;
    if (tool.length > 120 || !/^[A-Za-z0-9_.:@/-]+$/.test(tool)) {
      throw Object.assign(new Error(`Invalid harness tool name: ${tool}`), { statusCode: 400, code: 'HARNESS_INVALID' });
    }
    if (!seen.has(tool)) { seen.add(tool); result.push(tool); }
  }
  return result;
}

function normalizeHarness(value, { source = 'custom', scope = 'global', file = '' } = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw Object.assign(new Error('Harness name is required'), { statusCode: 400, code: 'HARNESS_INVALID' });
  const id = slugify(input.id || name);
  if (!id) throw Object.assign(new Error('Harness ID is required'), { statusCode: 400, code: 'HARNESS_INVALID' });
  if (BUILTIN_BY_ID.has(id) && source !== 'builtin') throw Object.assign(new Error(`Built-in harness ID cannot be overwritten: ${id}`), { statusCode: 409, code: 'HARNESS_BUILTIN' });
  const kind = String(input.kind || 'agent').trim().toLowerCase();
  if (!['agent', 'coding'].includes(kind)) throw Object.assign(new Error('Harness kind must be agent or coding'), { statusCode: 400, code: 'HARNESS_INVALID' });
  const appendSystemPrompt = String(input.appendSystemPrompt || '').trim();
  if (appendSystemPrompt.length > 24000) throw Object.assign(new Error('Harness system guidance is too large (24,000 character limit)'), { statusCode: 400, code: 'HARNESS_INVALID' });
  return {
    schemaVersion: 1,
    id,
    name,
    kind,
    description: String(input.description || '').trim().slice(0, 600),
    tools: normalizeTools(input.tools),
    appendSystemPrompt,
    resourcePolicy: 'inherit-pi',
    source,
    scope,
    editable: source !== 'builtin',
    file: file || undefined,
    updatedAt: String(input.updatedAt || new Date().toISOString())
  };
}

async function projectHarnessDir(workspace) {
  if (!String(workspace || '').trim()) return '';
  const root = await canonicalWorkspacePath(workspace);
  return path.join(root, '.pi', 'harnesses');
}

async function harnessDir(scope, workspace) {
  if (scope === 'project') {
    const dir = await projectHarnessDir(workspace);
    if (!dir) throw Object.assign(new Error('Project harnesses require an open workspace'), { statusCode: 400, code: 'HARNESS_WORKSPACE_REQUIRED' });
    return dir;
  }
  if (scope !== 'global') throw Object.assign(new Error(`Invalid harness scope: ${scope}`), { statusCode: 400, code: 'HARNESS_INVALID_SCOPE' });
  return GLOBAL_HARNESS_DIR;
}

async function loadHarnessDirectory(dir, scope) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return { harnesses: [], errors: [] }; throw error; }
  const harnesses = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    try {
      const raw = await readJsonStrict(file, {});
      harnesses.push(normalizeHarness(raw, { source: scope, scope, file }));
    } catch (error) {
      errors.push({ file, code: error?.code || 'HARNESS_LOAD_FAILED', error: error?.message || String(error) });
    }
  }
  harnesses.sort((a, b) => a.name.localeCompare(b.name));
  return { harnesses, errors };
}

export function listBuiltinHarnesses() {
  return BUILTIN_HARNESSES.map(cloneHarness);
}

export async function listHarnesses({ workspace = '' } = {}) {
  const globalResult = await loadHarnessDirectory(GLOBAL_HARNESS_DIR, 'global');
  const projectDir = String(workspace || '').trim() ? await projectHarnessDir(workspace) : '';
  const projectResult = projectDir ? await loadHarnessDirectory(projectDir, 'project') : { harnesses: [], errors: [] };
  const merged = new Map(listBuiltinHarnesses().map((item) => [item.id, item]));
  for (const item of globalResult.harnesses) merged.set(item.id, item);
  for (const item of projectResult.harnesses) merged.set(item.id, item); // project wins over global on the same custom id
  return { harnesses: [...merged.values()], errors: [...globalResult.errors, ...projectResult.errors] };
}

export async function resolveHarness(id = 'coding-default', { workspace = '' } = {}) {
  const key = String(id || 'coding-default').trim() || 'coding-default';
  const builtin = BUILTIN_BY_ID.get(key);
  if (builtin) return cloneHarness(builtin);
  const { harnesses } = await listHarnesses({ workspace });
  const harness = harnesses.find((item) => item.id === key);
  if (!harness) {
    throw Object.assign(new Error(`Unknown harness: ${key}`), { statusCode: 400, code: 'HARNESS_NOT_FOUND' });
  }
  return cloneHarness(harness);
}

export function composeHarnessSystemPrompt(harness, { now = new Date() } = {}) {
  const base = String(harness?.appendSystemPrompt || '').trim();
  if (harness?.id !== 'coding-web') return base;
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error('Invalid harness runtime date'), { statusCode: 500, code: 'HARNESS_DATE_INVALID' });
  const currentDate = date.toISOString().slice(0, 10);
  const currentNewsGuidance = [
    `Current date: ${currentDate}.`,
    'For latest, recent, or today queries, use the current date above and never inject a stale year from prior context.',
    'When publication dates are available, compare them and present current-news results newest-first.'
  ].join('\n');
  return [base, currentNewsGuidance].filter(Boolean).join('\n\n');
}

export async function saveHarness({ workspace = '', scope = 'global', harness = {} } = {}) {
  const dir = await harnessDir(scope, workspace);
  const normalized = normalizeHarness(harness, { source: scope, scope });
  const file = path.join(dir, `${normalized.id}.json`);
  return serializeMutation(file, async () => {
    // Existing corrupt manifests are never overwritten silently.
    const exists = await fs.stat(file).then((stat) => stat.isFile()).catch((error) => error?.code === 'ENOENT' ? false : Promise.reject(error));
    if (exists) await readJsonStrict(file, {});
    const stored = { ...normalized, source: undefined, scope: undefined, editable: undefined, file: undefined, updatedAt: new Date().toISOString() };
    for (const key of Object.keys(stored)) if (stored[key] === undefined) delete stored[key];
    await writeJsonAtomic(file, stored);
    return normalizeHarness(stored, { source: scope, scope, file });
  });
}

export async function deleteHarness({ workspace = '', scope = 'global', id = '' } = {}) {
  const key = slugify(id);
  if (!key) throw Object.assign(new Error('Harness ID is required'), { statusCode: 400, code: 'HARNESS_INVALID' });
  if (BUILTIN_BY_ID.has(key)) throw Object.assign(new Error('Built-in harnesses cannot be deleted'), { statusCode: 409, code: 'HARNESS_BUILTIN' });
  const dir = await harnessDir(scope, workspace);
  const file = path.join(dir, `${key}.json`);
  return serializeMutation(file, async () => {
    await fs.rm(file, { force: true });
    return { id: key, scope, file };
  });
}

export { CORE_TOOL_ORDER };
