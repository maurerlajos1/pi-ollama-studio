import { chromium } from '../vendor/e2e-runtime/node_modules/playwright/index.mjs';
import { promises as fs, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { prepareSpawn } from '../src/spawn-command.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const normalize = (value) => String(value || '').replace(/\r\n/g, '\n');

const OLLAMA_URL = String(process.env.PI_STUDIO_E2E_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const PRIMARY_MODEL = process.env.PI_STUDIO_E2E_MODEL || '15koutput';
const FALLBACK_MODEL = String(process.env.PI_STUDIO_E2E_FALLBACK_MODEL || '').trim();
const API_KEY_ENV = process.env.PI_STUDIO_OLLAMA_API_KEY_ENV || '';
const EFFECTIVE_API_KEY_ENV = API_KEY_ENV && process.env[API_KEY_ENV] ? API_KEY_ENV : '';
const PI_COMMAND = process.env.PI_STUDIO_E2E_PI_COMMAND || process.env.PI_COMMAND || 'pi';
const KEEP_ARTIFACTS = /^(1|true|yes)$/i.test(process.env.PI_STUDIO_E2E_KEEP_ARTIFACTS || '');
const MAX_AGENT_MS = Number(process.env.PI_STUDIO_E2E_AGENT_TIMEOUT_MS || 30 * 60 * 1000);

function installedModelKey(value) {
  return String(value || '').trim().toLowerCase().replace(/:latest$/, '');
}

function selectInstalledE2eModel(models = []) {
  const installed = models.map((item) => item?.model || item?.name || item).filter(Boolean);
  const isInstalled = (wanted) => Boolean(wanted)
    && installed.some((value) => installedModelKey(value) === installedModelKey(wanted));
  if (isInstalled(PRIMARY_MODEL)) return PRIMARY_MODEL;
  if (FALLBACK_MODEL && isInstalled(FALLBACK_MODEL)) return FALLBACK_MODEL;
  return null;
}

function runtimeKind(urlValue) {
  try {
    const url = new URL(urlValue);
    if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return 'local';
    if (url.protocol === 'https:') return 'https';
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) return 'lan';
    return 'remote';
  } catch { return 'remote'; }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

function browserExecutable() {
  const explicit = process.env.PI_STUDIO_CHROMIUM || process.env.CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/google-chrome-stable'];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function waitForServer(url, child) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode != null) throw new Error(`Studio server exited early with code ${child.exitCode}`);
    try { const response = await fetch(`${url}/api/bootstrap`); if (response.ok) return; } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error('Studio server did not become ready');
}

async function jsonRequest(url, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${url}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.ok === false) throw new Error(value.error || `${method} ${pathname}: ${response.status}`);
  return value;
}

async function poll(fn, predicate, { timeoutMs = 30000, intervalMs = 250, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try { last = await fn(); if (predicate(last)) return last; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function createFixture(root) {
  const workspace = path.join(root, 'counter-agent-project');
  await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'pi-studio-real-agent-e2e', version: '1.0.0', private: true, type: 'module',
    scripts: { test: 'node --test test/*.test.mjs' }
  }, null, 2));
  await fs.writeFile(path.join(workspace, 'test', 'counter.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { increment, describeCounter } from '../src/counter.mjs';\n\ntest('increment adds exactly one', () => assert.equal(increment(41), 42));\ntest('describeCounter formats the value', () => assert.equal(describeCounter(7), 'Counter: 7'));\n`);
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), `# E2E project rules\n- Do not edit the tests.\n- Keep implementation minimal.\n- Run npm test after edits.\n- Do not install dependencies.\n`);
  return workspace;
}

function runGit(workspace, args) {
  return execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd: workspace, encoding: 'utf8' });
}

function runNodeTests(workspace) {
  const prepared = prepareSpawn('npm', ['test'], { cwd: workspace, env: process.env });
  return execFileSync(prepared.command, prepared.args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    ...prepared.options
  });
}

async function writeProfileMetadata(studioDir) {
  await fs.mkdir(studioDir, { recursive: true });
  await fs.writeFile(path.join(studioDir, 'profiles.json'), `${JSON.stringify({ profiles: [{
    id: PRIMARY_MODEL,
    name: PRIMARY_MODEL,
    baseModel: PRIMARY_MODEL,
    contextWindow: 65536,
    maxTokens: 15000,
    reasoning: true,
    input: ['text'],
    parameters: { num_ctx: 65536, num_predict: 15000, temperature: 0.15, top_p: 0.9, top_k: 40, min_p: 0.05, repeat_penalty: 1.05 }
  }] }, null, 2)}\n`);
}

async function writeLocalInferenceSettings(agentDir) {
  // A large local model can spend several minutes loading into VRAM before
  // producing its first token. Keep this isolated E2E from Pi's normal
  // 5-minute provider deadline while retaining zero provider retries.
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'settings.json'), `${JSON.stringify({
    retry: { enabled: true, maxRetries: 0, provider: { timeoutMs: 1800000, maxRetries: 0, maxRetryDelayMs: 60000 } },
    httpIdleTimeoutMs: 1800000
  }, null, 2)}\n`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-real-ollama-e2e-'));
const workspace = await createFixture(root);
const protectedTestBefore = await fs.readFile(path.join(workspace, 'test', 'counter.test.mjs'), 'utf8');
const packageBefore = await fs.readFile(path.join(workspace, 'package.json'), 'utf8');
const studioDir = path.join(root, 'studio-data');
const piAgentDir = path.join(root, 'pi-agent');
const artifactsDir = path.resolve(process.env.PI_STUDIO_E2E_ARTIFACTS || path.join(APP_ROOT, 'test-results', 'ollama-e2e'));
await fs.rm(artifactsDir, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(artifactsDir, { recursive: true });
await writeProfileMetadata(studioDir);
await writeLocalInferenceSettings(piAgentDir);
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const serverLogs = [];
const kind = runtimeKind(OLLAMA_URL);
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: APP_ROOT,
  env: {
    ...process.env,
    STUDIO_PORT: String(port), STUDIO_BIND_HOST: '127.0.0.1',
    PI_OLLAMA_STUDIO_DIR: studioDir, PI_CODING_AGENT_DIR: piAgentDir,
    PI_COMMAND, PI_SKIP_VERSION_CHECK: '1',
    OLLAMA_BASE_URL: OLLAMA_URL,
    PI_STUDIO_OLLAMA_API_KEY_ENV: EFFECTIVE_API_KEY_ENV,
    PI_STUDIO_OLLAMA_RUNTIME_KIND: kind,
    PI_STUDIO_OLLAMA_RUNTIME_NAME: 'Real Ollama E2E'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()));
let browser;
let context;
let passed = false;
try {
  await waitForServer(url, server);
  if (API_KEY_ENV && !EFFECTIVE_API_KEY_ENV && runtimeKind(OLLAMA_URL) !== 'local') {
    console.warn(`WARN: ${API_KEY_ENV} is not set; remote Ollama E2E will try the endpoint without bearer authentication.`);
  }

  // Hardware/runtime preflight through Studio itself.
  await jsonRequest(url, '/api/bootstrap');
  let runtime = await jsonRequest(url, '/api/ollama/status');
  if (!runtime.ollama?.online && runtimeKind(OLLAMA_URL) === 'local') {
    console.log(`Ollama is offline at ${OLLAMA_URL}; starting the local managed Ollama process.`);
    await jsonRequest(url, '/api/ollama/managed/start', { method: 'POST', body: {} });
    runtime = await poll(
      () => jsonRequest(url, '/api/ollama/status'),
      (value) => value.ollama?.online === true,
      { timeoutMs: 30000, label: 'local Ollama startup' }
    );
  }
  check(runtime.ollama?.online === true, `Ollama runtime is offline at ${runtime.ollama?.runtime?.baseUrl || OLLAMA_URL}. Start Ollama or set PI_STUDIO_E2E_OLLAMA_URL to a reachable endpoint.`);
  // A locally managed Ollama can answer /api/version before its model store is
  // fully visible after a restart. Require the requested model, but tolerate
  // that short inventory-startup window instead of treating one empty /api/tags
  // response as authoritative.
  let model = selectInstalledE2eModel(runtime.ollama?.models || []);
  if (!model) {
    runtime = await poll(
      () => jsonRequest(url, '/api/ollama/status'),
      (value) => value.ollama?.online === true && Boolean(selectInstalledE2eModel(value.ollama?.models || [])),
      { timeoutMs: 60000, intervalMs: 500, label: `required Ollama model inventory (${PRIMARY_MODEL})` }
    ).catch(() => runtime);
    model = selectInstalledE2eModel(runtime.ollama?.models || []);
  }
  const installed = (runtime.ollama?.models || []).map((item) => item.model || item.name).filter(Boolean);
  const expected = FALLBACK_MODEL
    ? `'${PRIMARY_MODEL}' or explicitly configured fallback '${FALLBACK_MODEL}'`
    : `required model '${PRIMARY_MODEL}' (fallback disabled)`;
  check(model, `E2E model is not installed. Expected ${expected}. Installed: ${installed.join(', ') || '(none)'}`);
  await jsonRequest(url, '/api/ollama/sync', { method: 'POST', body: {} });
  const reasoningModels = ['15koutput', 'qwen3.6', 'uncensoredqwen3.6', 'fable-fusion'];
  const supportsReasoning = reasoningModels.some((r) => model.toLowerCase().includes(r));
  await jsonRequest(url, '/api/ollama/toggle-reasoning', { method: 'POST', body: { model, reasoning: supportsReasoning } });

  const executablePath = browserExecutable();
  check(executablePath, 'Chrome/Edge/Chromium not found. Set PI_STUDIO_CHROMIUM to the browser executable path.');
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--proxy-bypass-list=*'] });
  context = await browser.newContext({ viewport: { width: 1550, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`); });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.dataset.monacoState === 'ready', null, { timeout: 20000 });

  // Open disposable non-Git project, then use the real onboarding UI.
  await page.fill('#workspacePath', workspace);
  await page.click('#applyWorkspace');
  await page.locator('#gitOnboardingModal').waitFor({ state: 'visible', timeout: 10000 });
  await page.click('#gitInitConfirm');
  await page.locator('#gitOnboardingModal').waitFor({ state: 'hidden', timeout: 20000 });
  check(runGit(workspace, ['status', '--porcelain=v1', '-b']).startsWith('## main'), 'Git onboarding did not create a main repository');

  // Pick the detected real model and start real Pi.
  await page.waitForFunction((wanted) => [...document.querySelectorAll('#topModel option')].some((option) => option.value === wanted), model, { timeout: 20000 });
  await page.evaluate((m) => {
    const sel = document.querySelector('#topModel');
    sel.value = m;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, model);
  try {
    await page.waitForFunction((wanted) => {
      const workspaceReady = Boolean(document.querySelector('#workspacePath')?.value?.trim());
      const branchReady = /main|detached/i.test(document.querySelector('#gitSummary')?.textContent || '');
      const modelReady = document.querySelector('#topModel')?.value === wanted && !document.querySelector('#topModel option:checked')?.disabled;
      return workspaceReady && branchReady && modelReady && !document.querySelector('#startPi')?.disabled;
    }, model, { timeout: 60000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      workspace: document.querySelector('#workspacePath')?.value || '',
      branch: document.querySelector('#gitSummary')?.textContent || '',
      modelValue: document.querySelector('#topModel')?.value || '',
      modelOptions: [...document.querySelectorAll('#topModel option')].map((option) => ({ value: option.value, disabled: option.disabled, selected: option.selected })),
      startDisabled: Boolean(document.querySelector('#startPi')?.disabled),
      agentStatus: document.querySelector('#agentStatus')?.textContent || '',
      toast: document.querySelector('#toastHost')?.textContent || ''
    }));
    throw new Error(`${error.message}; launch readiness state=${JSON.stringify(state)}`);
  }
  await page.waitForTimeout(500);
  await page.click('#startPi');
  await page.locator('#sessionLauncherModal').waitFor({ state: 'visible', timeout: 120000 });
  await page.click('#confirmSessionLauncher');
  await page.waitForFunction(() => document.querySelector('#startPi')?.disabled && (document.querySelector('#agentStatus')?.textContent?.includes('Ready') || document.querySelector('#agentStatus')?.textContent?.includes('Working')), null, { timeout: 120000 });

  const firstPrompt = `E2E TASK 1. Inspect this project and make its existing tests pass. Implement src/counter.mjs only as needed. Requirements: export increment(value) returning value + 1; export describeCounter(value) returning exactly \`Counter: ${'${value}'}\`. Do not modify tests or package.json. Use your tools, run npm test, and keep working until tests pass. Finish your final response with E2E_COMPLETE.`;
  await page.fill('#composer', firstPrompt);
  await page.click('#sendPrompt');
  await page.waitForFunction(() => document.querySelector('#agentStatus')?.textContent?.includes('Working'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#agentStatus')?.textContent?.includes('Ready') && !document.querySelector('#sendPrompt')?.disabled, null, { timeout: MAX_AGENT_MS });

  const firstAssistantMessages = await page.locator('#messages .message.assistant:not(.error-message)').allTextContents();
  const firstAgentErrors = await page.locator('#messages .message.error-message').allTextContents();
  check(firstAssistantMessages.some((text) => text.includes('E2E_COMPLETE')), `First real-agent turn did not finish with the expected assistant completion marker. Assistant output: ${JSON.stringify(firstAssistantMessages)}. Agent errors: ${JSON.stringify(firstAgentErrors)}`);
  const implementation = normalize(await fs.readFile(path.join(workspace, 'src', 'counter.mjs'), 'utf8'));
  check(/increment/.test(implementation) && /describeCounter/.test(implementation), 'Agent did not create the expected counter implementation');
  const firstTestOutput = runNodeTests(workspace);
  check(/fail\s+0|passed|pass\s+2/i.test(firstTestOutput), `Project tests did not pass after real-agent turn:\n${firstTestOutput}`);
  check(runGit(workspace, ['status', '--porcelain', '-u']).includes('src/counter.mjs'), 'Agent-created implementation is not visible in Git changes');
  check(await fs.readFile(path.join(workspace, 'test', 'counter.test.mjs'), 'utf8') === protectedTestBefore, 'Agent modified protected tests during task 1');
  check(await fs.readFile(path.join(workspace, 'package.json'), 'utf8') === packageBefore, 'Agent modified package.json during task 1');

  // Wait for the prompt checkpoint to be associated with Pi's real user entry.
  const firstCheckpoints = await poll(
    () => jsonRequest(url, `/api/checkpoints?workspace=${encodeURIComponent(workspace)}`),
    (value) => Object.keys(value.checkpoints || {}).length >= 1,
    { timeoutMs: 30000, label: 'first prompt checkpoint association' }
  );
  check(Object.values(firstCheckpoints.checkpoints).some((cp) => cp.commit), 'First prompt did not receive a Git checkpoint');

  // Second real-agent turn: creates a second prompt snapshot. The snapshot must include task 1,
  // but be from before task 2 so historical worktree verification can prove restoration semantics.
  const secondPrompt = `E2E TASK 2. Create README.md documenting increment(value) and describeCounter(value). Do not modify src/counter.mjs or the tests. Run npm test again. Finish your final response with E2E_SECOND_COMPLETE.`;
  await page.fill('#composer', secondPrompt);
  await page.click('#sendPrompt');
  await page.waitForFunction(() => document.querySelector('#sendPrompt')?.disabled || document.querySelector('#agentStatus')?.textContent?.includes('Working'), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#agentStatus')?.textContent?.includes('Ready') && !document.querySelector('#sendPrompt')?.disabled, null, { timeout: MAX_AGENT_MS });
  const secondAssistantMessages = await page.locator('#messages .message.assistant:not(.error-message)').allTextContents();
  const secondAgentErrors = await page.locator('#messages .message.error-message').allTextContents();
  check(secondAssistantMessages.some((text) => text.includes('E2E_SECOND_COMPLETE')), `Second real-agent turn did not finish with the expected assistant completion marker. Assistant output: ${JSON.stringify(secondAssistantMessages)}. Agent errors: ${JSON.stringify(secondAgentErrors)}`);
  check(await fs.stat(path.join(workspace, 'README.md')).then(() => true).catch(() => false), 'Second agent turn did not create README.md');
  runNodeTests(workspace);
  check(normalize(await fs.readFile(path.join(workspace, 'src', 'counter.mjs'), 'utf8')) === implementation, 'Agent modified task-1 implementation during task 2');
  check(await fs.readFile(path.join(workspace, 'test', 'counter.test.mjs'), 'utf8') === protectedTestBefore, 'Agent modified protected tests during task 2');
  check(await fs.readFile(path.join(workspace, 'package.json'), 'utf8') === packageBefore, 'Agent modified package.json during task 2');

  const checkpointResponse = await poll(
    () => jsonRequest(url, `/api/checkpoints?workspace=${encodeURIComponent(workspace)}`),
    (value) => Object.keys(value.checkpoints || {}).length >= 2,
    { timeoutMs: 30000, label: 'second prompt checkpoint association' }
  );
  check(Object.keys(checkpointResponse.checkpoints || {}).length >= 2, 'Expected checkpoints for both real agent prompts');

  // Confirm Changes UI shows actual agent files and the Test Explorer passes through real UI APIs.
  await page.click('[data-view="git"]');
  await page.locator('#gitFileList').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#gitFileList')?.textContent?.includes('counter.mjs'), null, { timeout: 10000 });
  await page.click('[data-view="tests"]');
  await page.waitForFunction(() => document.querySelector('#testExplorerList')?.textContent?.includes('counter.test.mjs'), null, { timeout: 10000 });
  await page.click('#runAllTests');
  await page.waitForFunction(() => /passed|pass|fail/i.test(document.querySelector('#testOutput')?.textContent || ''), null, { timeout: 120000 });
  check(!/failed|fail(?:ed)?\s+[1-9]/i.test(await page.locator('#testOutput').textContent()), 'Test Explorer reported a failing suite after agent implementation');

  // Integrated xterm terminal: execute a real command through Studio terminal backend.
  await page.click('[data-view="terminal"]');
  await page.click('#newIntegratedTerminal');
  await page.waitForFunction(() => document.querySelectorAll('#terminalTabs .terminal-tab').length >= 1, null, { timeout: 15000 });
  const terminalInputCommand = process.platform === 'win32' ? 'Write-Output "OLLAMA_E2E_TERMINAL_OK"' : 'printf "OLLAMA_E2E_TERMINAL_OK\\n"';
  const sessions = await jsonRequest(url, '/api/terminal/sessions');
  const integrated = (sessions.sessions || []).find((item) => item.backend === 'pty' || item.backend === 'pipe');
  check(integrated, 'Integrated terminal session was not created');
  await jsonRequest(url, '/api/terminal/input', { method: 'POST', body: { id: integrated.id, data: `${terminalInputCommand}\r` } });
  await poll(
    () => jsonRequest(url, '/api/terminal/sessions'),
    (value) => (value.sessions || []).some((item) => item.id === integrated.id && String(item.history || '').includes('OLLAMA_E2E_TERMINAL_OK')),
    { timeoutMs: 15000, label: 'integrated terminal command output' }
  );

  // Session Tree must expose the second user prompt with its checkpoint badge.
  await page.click('[data-view="tree"]');
  await page.waitForFunction((text) => [...document.querySelectorAll('.session-tree-card')].some((card) => card.textContent.includes(text) && card.textContent.includes('Create App from Snapshot')), secondPrompt.slice(0, 60), { timeout: 20000 });
  const secondCard = page.locator('.session-tree-card').filter({ hasText: 'E2E TASK 2' }).first();
  check(await secondCard.count(), 'Second real-agent prompt is missing from Session Tree');

  // Create historical project from the pre-task-2 snapshot through the actual UI.
  const projectName = `ollama-e2e-snapshot-${Date.now()}`;
  await secondCard.getByRole('button', { name: /Create App from Snapshot/i }).click();
  await page.locator('#projectWizardModal').waitFor({ state: 'visible', timeout: 10000 });
  await page.fill('#projectWizardName', projectName);
  const createProjectResponse = page.waitForResponse((response) => response.url().includes('/api/sessions/create-project') && response.request().method() === 'POST', { timeout: 120000 });
  await page.click('#projectWizardCreate');
  const createProjectResult = await createProjectResponse;
  check(createProjectResult.ok(), `Historical project creation request failed with HTTP ${createProjectResult.status()}: ${await createProjectResult.text()}`);
  await page.locator('#projectWizardModal').waitFor({ state: 'hidden', timeout: 120000 });
  await page.waitForFunction((original) => {
    const current = String(document.querySelector('#workspacePath')?.value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const previous = String(original || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return current && current !== previous;
  }, workspace, { timeout: 120000 });
  const restoredWorkspace = await page.inputValue('#workspacePath');
  check(await fs.stat(path.join(restoredWorkspace, 'src', 'counter.mjs')).then(() => true).catch(() => false), 'Historical worktree does not contain task-1 implementation');
  check(!(await fs.stat(path.join(restoredWorkspace, 'README.md')).then(() => true).catch(() => false)), 'Historical pre-task-2 worktree incorrectly contains task-2 README');
  runNodeTests(restoredWorkspace);

  const actualErrors = pageErrors.filter((value) => !/Canceled|abort/i.test(String(value)));
  check(actualErrors.length === 0, `Browser errors detected:\n${actualErrors.join('\n')}`);
  await page.screenshot({ path: path.join(artifactsDir, 'final.png'), fullPage: true });
  await context.tracing.stop({ path: path.join(artifactsDir, 'trace.zip') });
  passed = true;
  console.log(`PASS: Real Ollama + Pi UI E2E using ${model}`);
  console.log(`  Ollama: ${OLLAMA_URL}`);
  console.log(`  Project: agent edit → tests → checkpoint → second edit → historical worktree verified`);
  console.log(`  Artifacts: ${artifactsDir}`);
} catch (error) {
  if (context) {
    await context.pages()[0]?.screenshot({ path: path.join(artifactsDir, 'failure.png'), fullPage: true }).catch(() => {});
    await context.tracing.stop({ path: path.join(artifactsDir, 'trace.zip') }).catch(() => {});
  }
  await fs.writeFile(path.join(artifactsDir, 'server.log'), serverLogs.join(''), 'utf8').catch(() => {});
  await fs.writeFile(path.join(artifactsDir, 'error.txt'), `${error.stack || error}\n`, 'utf8').catch(() => {});
  console.error(`FAIL: Real Ollama + Pi UI E2E\n${error.stack || error}`);
  console.error(`Artifacts: ${artifactsDir}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(3000)]).catch(() => {});
  if (server.exitCode == null) server.kill('SIGKILL');
  if (passed && !KEEP_ARTIFACTS) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  else console.log(`Disposable workspace retained at: ${root}`);
}
