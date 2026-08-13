import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCommand } from './system.mjs';

const IGNORED = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo', '.venv', 'venv', '__pycache__']);
const TEST_RE = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test\.|\.spec\.)|(?:^|\/)test_[^/]+\.py$/i;

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function walkFiles(root, { limit = 2500 } = {}) {
  const files = [];
  async function walk(dir) {
    if (files.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return files;
}

function detectJsFramework(pkg = {}) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.vitest) return 'vitest';
  if (deps.jest || deps['@jest/core']) return 'jest';
  if (deps.mocha) return 'mocha';
  const testScript = String(pkg.scripts?.test || '');
  if (/vitest/i.test(testScript)) return 'vitest';
  if (/jest/i.test(testScript)) return 'jest';
  if (/mocha/i.test(testScript)) return 'mocha';
  if (/node\s+--test/i.test(testScript)) return 'node-test';
  return null;
}

async function discoverCases(root, relative, language) {
  const file = path.join(root, relative);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > 1024 * 1024) return [];
  const source = await fs.readFile(file, 'utf8').catch(() => '');
  const names = [];
  const seen = new Set();
  const add = (name, line) => {
    const value = String(name || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    names.push({ id: `${relative}::${value}`, name: value.slice(0, 240), line, kind: 'case' });
  };
  if (language === 'python') {
    for (const match of source.matchAll(/^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/gm)) {
      add(match[1], source.slice(0, match.index).split('\n').length);
      if (names.length >= 200) break;
    }
  } else {
    const re = /\b(?:test|it)\s*\(\s*(['"`])([^'"`\r\n]{1,240})\1/g;
    for (const match of source.matchAll(re)) {
      add(match[2], source.slice(0, match.index).split('\n').length);
      if (names.length >= 200) break;
    }
  }
  return names;
}

export async function discoverTests(workspace) {
  const root = path.resolve(String(workspace || ''));
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('Workspace does not exist');
  const files = await walkFiles(root);
  const pkg = await readJson(path.join(root, 'package.json'));
  const jsFramework = detectJsFramework(pkg || {});
  const hasPyproject = Boolean(await fs.stat(path.join(root, 'pyproject.toml')).catch(() => null));
  const hasPytestIni = Boolean(await fs.stat(path.join(root, 'pytest.ini')).catch(() => null));
  const tests = await Promise.all(files.filter((file) => TEST_RE.test(file)).map(async (file) => {
    const ext = path.extname(file).toLowerCase();
    const python = ext === '.py';
    const language = python ? 'python' : 'javascript';
    return {
      id: file,
      path: file,
      name: path.basename(file),
      language,
      framework: python ? 'pytest' : (jsFramework || 'node-test'),
      kind: 'file',
      cases: await discoverCases(root, file, language)
    };
  }));
  const scripts = Object.entries(pkg?.scripts || {}).map(([name, command]) => ({ name, command: String(command) }));
  return {
    workspace: root,
    tests,
    scripts,
    defaults: {
      testScript: pkg?.scripts?.test ? 'test' : null,
      jsFramework,
      python: hasPyproject || hasPytestIni || tests.some((test) => test.language === 'python')
    }
  };
}

async function validateRelativeTestPath(root, relative) {
  const target = path.resolve(root, String(relative || ''));
  const rel = path.relative(root, target);
  if (!relative || rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('Test path escapes workspace'), { statusCode: 403 });
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  const canonicalRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  const canonicalTarget = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
  const realRel = path.relative(canonicalRoot, canonicalTarget);
  if (canonicalTarget !== canonicalRoot && (realRel.startsWith('..') || path.isAbsolute(realRel))) {
    throw Object.assign(new Error('Test path escapes workspace'), { statusCode: 403 });
  }
  return target;
}

async function commandForTest({ root, discovery, target, testName, mode }) {
  const pkg = discovery;
  if (mode === 'all') {
    if (pkg.defaults.testScript) return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'], label: 'npm test' };
    if (pkg.defaults.python) return { command: process.platform === 'win32' ? 'python.exe' : 'python3', args: ['-m', 'pytest'], label: 'pytest' };
    return { command: process.execPath, args: ['--test'], label: 'node --test' };
  }

  const absolute = await validateRelativeTestPath(root, target);
  const rel = path.relative(root, absolute);
  const item = discovery.tests.find((test) => test.path === target);
  const name = String(testName || '').trim();
  if (item?.language === 'python') return { command: process.platform === 'win32' ? 'python.exe' : 'python3', args: ['-m', 'pytest', rel, ...(name ? ['-k', name] : [])], label: `pytest ${rel}${name ? ` :: ${name}` : ''}` };
  if (item?.framework === 'vitest') return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['vitest', 'run', rel, ...(name ? ['-t', name] : [])], label: `vitest ${rel}${name ? ` :: ${name}` : ''}` };
  if (item?.framework === 'jest') return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['jest', rel, '--runInBand', ...(name ? ['-t', name] : [])], label: `jest ${rel}${name ? ` :: ${name}` : ''}` };
  if (item?.framework === 'mocha') return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['mocha', rel, ...(name ? ['--grep', name] : [])], label: `mocha ${rel}${name ? ` :: ${name}` : ''}` };
  return { command: process.execPath, args: ['--test', ...(name ? ['--test-name-pattern', name] : []), rel], label: `node --test ${rel}${name ? ` :: ${name}` : ''}` };
}

export async function runTests(workspace, { target = null, testName = '', mode = 'all', timeoutMs = 120000 } = {}) {
  const root = path.resolve(String(workspace || ''));
  const discovery = await discoverTests(root);
  const spec = await commandForTest({ root, discovery, target, testName, mode: target ? 'file' : mode });
  const startedAt = Date.now();
  const result = await runCommand(spec.command, spec.args, {
    cwd: root,
    timeoutMs: Math.max(1000, Math.min(15 * 60 * 1000, Number(timeoutMs) || 120000)),
    maxBytes: 8 * 1024 * 1024,
    env: { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
  });
  return {
    ...result,
    command: [spec.command, ...spec.args].join(' '),
    label: spec.label,
    target: target || null,
    testName: String(testName || '') || null,
    durationMs: Date.now() - startedAt,
    passed: result.code === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n')
  };
}

export async function discoverRunConfigurations(workspace) {
  const discovery = await discoverTests(workspace);
  const configs = [];
  for (const script of discovery.scripts) {
    configs.push({
      id: `npm:${script.name}`,
      name: `npm: ${script.name}`,
      command: `npm run ${script.name}`,
      script: script.name,
      type: 'npm'
    });
  }
  if (!configs.some((item) => item.script === 'test') && discovery.tests.length) {
    configs.push({ id: 'tests:all', name: 'Run all tests', command: 'npm test', type: 'tests' });
  }
  return { workspace: discovery.workspace, configurations: configs };
}
