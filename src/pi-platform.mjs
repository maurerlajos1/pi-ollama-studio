import { installedPackageView } from './pi-packages.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonStrict, serializeMutation } from './config.mjs';

const MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_DISCOVERED = 1000;
const EXTENSION_EXTS = new Set(['.ts', '.js', '.mjs', '.cjs']);
const CONTEXT_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md']);

function estimateTokens(text = '') {
  return Math.max(0, Math.ceil(String(text).length / 4));
}

function normalizeSlashes(value) {
  return String(value || '').split(path.sep).join('/');
}

async function exists(target) {
  return Boolean(await fs.stat(target).catch(() => null));
}

async function readText(target, maxBytes = MAX_RESOURCE_BYTES) {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size > maxBytes) {
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return `${buffer.subarray(0, bytesRead).toString('utf8')}\n\n[Pi Studio preview truncated at ${maxBytes} bytes]`;
    } finally {
      await handle.close();
    }
  }
  return fs.readFile(target, 'utf8');
}

async function readJson(target) {
  try {
    const text = await fs.readFile(target, 'utf8');
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function deepMerge(base, override) {
  const result = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function flattenSettings(value, prefix = '', output = {}) {
  for (const [key, child] of Object.entries(value || {})) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flattenSettings(child, current, output);
    else output[current] = child;
  }
  return output;
}

function settingsRows(globalSettings, projectSettings) {
  const globalFlat = flattenSettings(globalSettings);
  const projectFlat = flattenSettings(projectSettings);
  const effectiveFlat = flattenSettings(deepMerge(globalSettings, projectSettings));
  return Object.keys(effectiveFlat).sort().map((key) => ({
    key,
    globalValue: Object.hasOwn(globalFlat, key) ? globalFlat[key] : undefined,
    projectValue: Object.hasOwn(projectFlat, key) ? projectFlat[key] : undefined,
    effectiveValue: effectiveFlat[key],
    source: Object.hasOwn(projectFlat, key) ? 'project' : 'global'
  }));
}

function parseFrontmatter(text = '') {
  const value = String(text || '');
  if (!value.startsWith('---\n') && !value.startsWith('---\r\n')) return { frontmatter: {}, body: value };
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: value };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let raw = line.slice(idx + 1).trim();
    raw = raw.replace(/^['"]|['"]$/g, '');
    if (key) frontmatter[key] = raw;
  }
  return { frontmatter, body: value.slice(match[0].length) };
}

function firstMeaningfulLine(text = '') {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#') && line !== '---') || '';
}

async function atomicWriteText(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.pi-studio-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fs.writeFile(temp, String(content), 'utf8');
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function safeName(value, suffix = '') {
  const name = String(value || '').trim();
  if (!name || name.length > 100 || name.includes('/') || name.includes('\\') || name.includes('..') || /[<>:"|?*\0]/.test(name)) {
    throw Object.assign(new Error('Resource name contains unsupported characters'), { statusCode: 400 });
  }
  return suffix && !name.toLowerCase().endsWith(suffix.toLowerCase()) ? `${name}${suffix}` : name;
}

export function getPiAgentDir(env = process.env) {
  return path.resolve(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'));
}

async function findGitRoot(workspace) {
  let current = path.resolve(workspace);
  while (true) {
    if (await exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function projectAncestors(workspace) {
  const resolved = path.resolve(workspace);
  const gitRoot = await findGitRoot(resolved);
  const stop = gitRoot || path.parse(resolved).root;
  const list = [];
  let current = resolved;
  while (true) {
    list.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return list.reverse();
}

async function resourceFromFile(file, { kind, scope, origin, root, commandName = '', description = '' } = {}) {
  const content = await readText(file);
  if (content == null) return null;
  const stat = await fs.stat(file);
  const parsed = parseFrontmatter(content);
  return {
    kind,
    scope,
    origin,
    path: file,
    relativePath: root ? normalizeSlashes(path.relative(root, file)) : path.basename(file),
    name: commandName || path.basename(file, path.extname(file)),
    description: description || parsed.frontmatter.description || firstMeaningfulLine(parsed.body),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    estimatedTokens: estimateTokens(content),
    content
  };
}

async function discoverPromptDir(root, scope, origin) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (result.length >= MAX_DISCOVERED) break;
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
    const item = await resourceFromFile(path.join(root, entry.name), { kind: 'prompt', scope, origin, root });
    if (item) result.push(item);
  }
  return result;
}

async function discoverSkills(root, scope, origin, { rootMd = true } = {}) {
  const baseStat = await fs.stat(root).catch(() => null);
  if (!baseStat?.isDirectory()) return [];
  const result = [];
  async function walk(dir, depth) {
    if (result.length >= MAX_DISCOVERED || depth > 8) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (result.length >= MAX_DISCOVERED) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await exists(path.join(target, 'SKILL.md'))) {
          const item = await resourceFromFile(path.join(target, 'SKILL.md'), { kind: 'skill', scope, origin, root, commandName: entry.name });
          if (item) result.push(item);
          continue;
        }
        await walk(target, depth + 1);
      } else if (rootMd && depth === 0 && entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        const item = await resourceFromFile(target, { kind: 'skill', scope, origin, root });
        if (item) result.push(item);
      }
    }
  }
  await walk(root, 0);
  return result;
}

async function discoverExtensions(root, scope, origin) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const result = [];
  async function walk(dir, depth) {
    if (result.length >= MAX_DISCOVERED || depth > 5) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (result.length >= MAX_DISCOVERED) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target, depth + 1);
      else if (entry.isFile() && EXTENSION_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const item = await resourceFromFile(target, { kind: 'extension', scope, origin, root });
        if (item) result.push({ ...item, description: item.description || 'Executable Pi extension — inspect before enabling.' });
      }
    }
  }
  await walk(root, 0);
  return result;
}

async function contextHierarchy(workspace, agentDir) {
  const result = [];
  const globalFile = path.join(agentDir, 'AGENTS.md');
  if (await exists(globalFile)) {
    const item = await resourceFromFile(globalFile, { kind: 'context', scope: 'global', origin: 'global AGENTS.md', root: agentDir, commandName: 'AGENTS.md' });
    if (item) result.push(item);
  }
  for (const dir of await projectAncestors(workspace)) {
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(dir, filename);
      if (!(await exists(file))) continue;
      const item = await resourceFromFile(file, { kind: 'context', scope: dir === path.resolve(workspace) ? 'project' : 'ancestor', origin: normalizeSlashes(dir), root: workspace, commandName: filename });
      if (item) result.push(item);
    }
  }
  for (const [scope, base] of [['global', agentDir], ['project', path.join(workspace, '.pi')]]) {
    for (const filename of ['SYSTEM.md', 'APPEND_SYSTEM.md']) {
      const file = path.join(base, filename);
      if (!(await exists(file))) continue;
      const item = await resourceFromFile(file, { kind: 'system-prompt', scope, origin: `${scope} ${filename}`, root: base, commandName: filename });
      if (item) result.push(item);
    }
  }
  return result;
}

function normalizePackages(settings, scope) {
  return Array.isArray(settings?.packages)
    ? settings.packages.map((entry, index) => installedPackageView(entry, scope, index)).filter((item) => item.source)
    : [];
}

export async function inspectPiPlatform(workspace, { env = process.env } = {}) {
  if (!workspace) throw Object.assign(new Error('Workspace is required'), { statusCode: 400 });
  const root = path.resolve(workspace);
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw Object.assign(new Error('Workspace directory does not exist'), { statusCode: 404 });
  const agentDir = getPiAgentDir(env);
  const projectPi = path.join(root, '.pi');
  const ancestors = await projectAncestors(root);

  const globalSettingsPath = path.join(agentDir, 'settings.json');
  const projectSettingsPath = path.join(projectPi, 'settings.json');
  const [globalSettings, projectSettings] = await Promise.all([readJson(globalSettingsPath), readJson(projectSettingsPath)]);

  const prompts = [
    ...(await discoverPromptDir(path.join(agentDir, 'prompts'), 'global', '~/.pi/agent/prompts')),
    ...(await discoverPromptDir(path.join(projectPi, 'prompts'), 'project', '.pi/prompts'))
  ];
  const skills = [
    ...(await discoverSkills(path.join(agentDir, 'skills'), 'global', '~/.pi/agent/skills', { rootMd: true })),
    ...(await discoverSkills(path.join(os.homedir(), '.agents', 'skills'), 'global', '~/.agents/skills', { rootMd: false })),
    ...(await discoverSkills(path.join(projectPi, 'skills'), 'project', '.pi/skills', { rootMd: true }))
  ];
  for (const dir of ancestors) {
    skills.push(...await discoverSkills(path.join(dir, '.agents', 'skills'), dir === root ? 'project' : 'ancestor', `${normalizeSlashes(dir)}/.agents/skills`, { rootMd: false }));
  }
  const extensions = [
    ...(await discoverExtensions(path.join(agentDir, 'extensions'), 'global', '~/.pi/agent/extensions')),
    ...(await discoverExtensions(path.join(projectPi, 'extensions'), 'project', '.pi/extensions'))
  ];
  const contextFiles = await contextHierarchy(root, agentDir);
  const packages = [...normalizePackages(globalSettings, 'global'), ...normalizePackages(projectSettings, 'project')];
  const persistentContextTokens = contextFiles.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const skillDiscoveryTokens = skills.reduce((sum, item) => sum + estimateTokens(`${item.name}: ${item.description}`), 0);

  return {
    workspace: root,
    agentDir,
    trustSensitive: extensions.some((item) => item.scope !== 'global') || skills.some((item) => item.scope === 'project' || item.scope === 'ancestor') || await exists(projectSettingsPath),
    contextFiles,
    prompts,
    skills,
    extensions,
    packages,
    settings: {
      globalPath: globalSettingsPath,
      projectPath: projectSettingsPath,
      global: globalSettings,
      project: projectSettings,
      effective: deepMerge(globalSettings, projectSettings),
      rows: settingsRows(globalSettings, projectSettings)
    },
    contextEstimate: {
      note: 'Approximate only. Context files are persistent inputs; skill descriptions are discovered metadata. Prompt templates and extension source are not counted as active context here.',
      persistentContextTokens,
      skillDiscoveryTokens,
      combinedKnownTokens: persistentContextTokens + skillDiscoveryTokens,
      files: contextFiles.map(({ name, path: filePath, scope, estimatedTokens }) => ({ name, path: filePath, scope, estimatedTokens }))
    },
    counts: {
      contextFiles: contextFiles.length,
      prompts: prompts.length,
      skills: skills.length,
      extensions: extensions.length,
      packages: packages.length,
      settings: settingsRows(globalSettings, projectSettings).length
    }
  };
}

function scopeRoot(workspace, scope, kind, env = process.env) {
  const root = path.resolve(workspace);
  const agentDir = getPiAgentDir(env);
  if (!['global', 'project'].includes(scope)) throw Object.assign(new Error('Scope must be global or project'), { statusCode: 400 });
  if (kind === 'prompt') return scope === 'global' ? path.join(agentDir, 'prompts') : path.join(root, '.pi', 'prompts');
  if (kind === 'skill') return scope === 'global' ? path.join(agentDir, 'skills') : path.join(root, '.pi', 'skills');
  if (kind === 'context') return scope === 'global' ? agentDir : root;
  if (kind === 'system-prompt') return scope === 'global' ? agentDir : path.join(root, '.pi');
  if (kind === 'settings') return scope === 'global' ? agentDir : path.join(root, '.pi');
  throw Object.assign(new Error('Unsupported resource kind'), { statusCode: 400 });
}

export async function writePromptTemplate(workspace, { scope = 'project', name, content = '' } = {}, { env = process.env } = {}) {
  const root = scopeRoot(workspace, scope, 'prompt', env);
  await fs.mkdir(root, { recursive: true });
  const filename = safeName(name, '.md');
  const target = path.join(root, filename);
  await atomicWriteText(target, String(content));
  return { scope, name: path.basename(filename, '.md'), path: target };
}

export async function writeSkill(workspace, { scope = 'project', name, content = '' } = {}, { env = process.env } = {}) {
  const root = scopeRoot(workspace, scope, 'skill', env);
  await fs.mkdir(root, { recursive: true });
  const folder = safeName(name);
  const targetDir = path.join(root, folder);
  await fs.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, 'SKILL.md');
  await atomicWriteText(target, String(content));
  return { scope, name: folder, path: target };
}

export async function writeContextFile(workspace, { scope = 'project', name = 'AGENTS.md', content = '' } = {}, { env = process.env } = {}) {
  if (!CONTEXT_NAMES.has(name)) throw Object.assign(new Error('Unsupported context filename'), { statusCode: 400 });
  const kind = name === 'SYSTEM.md' || name === 'APPEND_SYSTEM.md' ? 'system-prompt' : 'context';
  const root = scopeRoot(workspace, scope, kind, env);
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, name);
  await atomicWriteText(target, String(content));
  return { scope, name, path: target };
}

export async function writePiSettings(workspace, { scope = 'project', settings } = {}, { env = process.env } = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Object.assign(new Error('Settings must be a JSON object'), { statusCode: 400 });
  const root = scopeRoot(workspace, scope, 'settings', env);
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, 'settings.json');
  await serializeMutation(target, async () => { await readJsonStrict(target, {}); await atomicWriteText(target, `${JSON.stringify(settings, null, 2)}\n`); });
  return { scope, path: target, settings };
}

export const __test = { estimateTokens, parseFrontmatter, deepMerge, settingsRows, safeName, normalizePackages };
