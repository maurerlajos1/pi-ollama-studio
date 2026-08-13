import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const piRpc = await readFile(new URL('../src/pi-rpc.mjs', import.meta.url), 'utf8');

test('workspace switch tears down all old workspace-owned state before activating canonical new root', () => {
  assert.match(app, /async function leaveWorkspaceContext\(previousWorkspace\)/);
  assert.match(app, /post\('\/api\/pi\/stop', \{ workspace: previousWorkspace \}\)/);
  assert.match(app, /post\('\/api\/pi\/stop', \{ workspace: context\.workspace \}\)/);
  assert.match(app, /post\('\/api\/preview\/stop', \{ workspace: previousWorkspace \}\)/);
  assert.match(app, /post\('\/api\/terminal\/kill', \{ id \}\)/);
  assert.match(app, /api\(`\/api\/terminal\/sessions\?workspace=\$\{enc\(previousWorkspace\)\}`\)/);
  assert.match(app, /workspaceEpoch/);
  assert.match(app, /workspaceContextIsCurrent/);
  assert.match(app, /const context = captureWorkspaceContext\(\);[\s\S]*?post\('\/api\/tests\/run', \{ workspace: context\.workspace/);
  assert.match(app, /if \(!workspaceContextIsCurrent\(context\)\) return;/);
  assert.match(app, /writeEditorBuffer\(buffer, content, \{ workspace: context\.workspace \}\)/);
  assert.match(app, /post\('\/api\/lsp\/stop', \{ workspace: previousWorkspace \}\)/);
  assert.match(app, /renderMessages\(\[\]\)/);
  assert.match(app, /app\.problems = \[\]/);
  assert.match(app, /app\.lspStatuses = \[\]/);
  assert.match(app, /app\.attachments = \[\]/);
  assert.match(app, /app\.currentInspectedSession = null/);
  assert.match(app, /app\.currentExtensionRequest = null/);
  assert.match(app, /app\.tests = \{ discovery: null/);
  assert.match(app, /app\.platform\.snapshot = null/);
  assert.match(app, /const nextWorkspace = String\(treeProbe\?\.tree\?\.workspace \|\| requestedWorkspace\)/);
  assert.match(app, /app\.workspace = nextWorkspace/);
  assert.match(app, /loadCheckpoints\(\)/);
  assert.match(app, /loadPiPlatform\(\{ quiet: true \}\)/);
  assert.match(app, /previewPanel\?\.refresh\?\.\(\)/);
});

test('Create App from Prompt switches workspace and rebinds the newly-created forked session', () => {
  assert.match(app, /projectWizardState = \{ mode: 'session',[\s\S]*wasPiRunning: Boolean\(app\.pi\.status\?\.running\)/);
  assert.match(app, /const switched = await switchWorkspace\(res\.workspacePath\)/);
  assert.match(app, /if \(state\.wasPiRunning && getSelectedModelId\(\)\) await startPi\(res\.sessionPath, `\$\{res\.projectName\} Initial Session`\)/);
  assert.match(app, /else await inspectSessionTree\(res\.sessionPath\)/);
});

test('Ollama Test Connection exposes tested inventories without pretending the active runtime switched', () => {
  assert.match(html, /id="useTestedOllama"/);
  assert.match(html, /id="testedOllamaInventory"/);
  assert.match(html, /id="activeOllamaInventory"/);
  assert.match(app, /app\.testedOllama = value\.result/);
  assert.match(app, /renderOllamaRuntimeStatus\(app\.ollama\)/);
  assert.match(app, /Loaded now:/);
  assert.match(app, /\$\('#useTestedOllama'\)\.onclick = \(\) => executeAppCommand\('ollama\.useTestedRuntime'\)/);
  assert.match(app, /Test the current Ollama connection settings, then choose Use this server before switching/);
  assert.match(app, /Downloads to active runtime/);
  assert.match(html, /id="pullModelTarget"/);
});

test('reload restores a running Pi workspace when persisted workspace state is empty or stale', () => {
  assert.match(app, /const runningPiWorkspace = value\.pi\?\.status\?\.running/);
  assert.match(app, /app\.config\.defaultWorkspace = runningPiWorkspace/);
  assert.match(app, /put\('\/api\/config', \{ defaultWorkspace: runningPiWorkspace \}\)/);
});

test('runtime switch invalidates old inventory and stops running Pi before switching endpoint', () => {
  assert.match(app, /switchingRuntime && app\.pi\.status\?\.running\) await stopPi\(\)/);
  assert.match(app, /app\.ollama = \{ online: false, models: \[\], running: \[\]/);
  assert.match(app, /await refreshOllama\(\)/);
  assert.match(app, /await post\('\/api\/ollama\/sync'\)/);
});


test('Studio profile selectors use real model IDs as values, not display names', () => {
  assert.match(app, /const val = p\.id \|\| p\.name/);
  assert.doesNotMatch(app, /const val = p\.name \|\| p\.id/);
  assert.match(app, /const compatibleProfiles = profiles\.filter\(\(profile\) => profileRuntimeState\(profile\)\.compatible\)/);
  assert.match(app, /group\.label = `Ollama Models · \$\{app\.ollama\?\.runtime\?\.name/);
});


test('workspace activation is commit-once after leaving the previous context', () => {
  const block=app.match(/async function switchWorkspace\([\s\S]*?\n}\n\nasync function applyWorkspace/);
  assert.ok(block,'switchWorkspace implementation missing');
  assert.match(block[0],/Promise\.allSettled/,'secondary workspace reloads must not fake a rollback');
  assert.match(block[0],/const warnings = \[\]/);
  assert.match(block[0],/app\.workspace = nextWorkspace/);
  assert.doesNotMatch(block[0],/app\.workspace = previousWorkspace/);
});


test('runtime model selector hides unavailable profiles and replaces stale A selections with a valid B model', () => {
  assert.match(app, /function activeOllamaHasModel\(modelId\)/);
  assert.match(app, /reason: 'missing-model'/);
  assert.match(app, /const compatibleProfiles = profiles\.filter/);
  assert.match(app, /const firstAvailable = \[\.\.\.topModel\.options\]\.find/);
  assert.match(app, /localStorage\.removeItem\('studio_selected_model'\)/);
});


test('Ollama runtime activation restores A if persistence fails and commits B before refresh warnings', () => {
  const block=app.match(/async function saveRuntime\([\s\S]*?\n}\nasync function saveCommands/);
  assert.ok(block,'saveRuntime implementation missing');
  assert.match(block[0],/const previousOllama = app\.ollama/);
  assert.match(block[0],/app\.ollama = previousOllama/);
  assert.match(block[0],/const warnings = \[\]/);
  assert.match(block[0],/refreshOllama\(\)\.catch/);
  assert.match(block[0],/post\('\/api\/ollama\/sync'\)\.catch/);
});


test('Use this server is bound to the exact tested URL/auth/runtime-kind fingerprint', () => {
  assert.match(app, /function currentRuntimeTestFingerprint\(\)/);
  assert.match(app, /apiKeyEnv: String\(\$\('#ollamaApiKeyEnv'\)/);
  assert.match(app, /kind: String\(\$\('#ollamaRuntimeKind'\)/);
  assert.match(app, /currentRuntimeTestFingerprint\(\) !== testedRuntimeFingerprint\(tested\)/);
  assert.match(app, /\(requireTestedRuntime \|\| runtimeIdentityChanged\) && candidateFingerprint !== testedRuntimeFingerprint/);
  assert.match(app, /function testedRuntimeIsActive\(tested = app\.testedOllama\)/);
  assert.match(app, /button\.textContent = alreadyActive \? 'Already active' : 'Use this server'/);
  assert.match(app, /This is the active Studio runtime/);
});


test('visible model selection and backend defaultModel stay authoritative together', () => {
  assert.match(app, /async function persistDefaultModelSelection\(modelId/);
  assert.match(app, /put\('\/api\/config', \{ defaultModel: selected \}\)/);
  assert.match(app, /if \(switchingRuntime\)[\s\S]*persistDefaultModelSelection\(selectedForRuntime/);
  assert.match(app, /\$\('#topModel'\)\.onchange[\s\S]*await chooseModel\(selected\)/);
  assert.match(app, /async function chooseModel\([\s\S]*await persistDefaultModelSelection\(selected\)/);
});


test('failed live model switches never become persisted startup defaults', () => {
  assert.match(app, /return true;[\s\S]*return false;[\s\S]*async function createPromptCheckpoint/);
  assert.match(app, /if \(app\.pi\.status\?\.running\)[\s\S]*const switched = await switchModel\(rawModel, provider \|\| undefined\)/);
  assert.match(app, /if \(!switched\)[\s\S]*return false;[\s\S]*persistDefaultModelSelection\(selected\)/);
  assert.match(app, /app\.pi\.status\?\.running \? app\.pi\.status\?\.modelId : app\.config\?\.defaultModel/);
  assert.match(app, /\$\('#customModelInput'\)\.onchange = async/);
});

test('first prompt starts Pi with the selected harness before sending', () => {
  const block = app.match(/async function sendPrompt\(mode = 'prompt'\)[\s\S]*?\n}\n\nfunction switchView/);
  assert.ok(block, 'sendPrompt implementation missing');
  assert.doesNotMatch(block[0], /Start Pi first/);
  assert.match(block[0], /if \(!app\.pi\.status\?\.running\)/);
  assert.match(block[0], /await startPi\(null, '', \{ harnessId: selectedHarnessId\(\), thinkingLevel: \$\('#thinkingLevel'\)\?\.value \|\| 'off' \}\)/);
  assert.match(block[0], /if \(!started \|\| !app\.pi\.status\?\.running\)/);
  assert.match(block[0], /await rpc\(command, \{ quiet: true \}\)/);
});

test('session launcher remains open on startup failure and restores Start button state from Pi truth', () => {
  const launcher = app.match(/async function applySessionLauncherSelection\(\)[\s\S]*?\n}\n\n\/\/ .*Model Selector/);
  assert.ok(launcher);
  assert.match(launcher[0], /const started = await startPi/);
  assert.match(launcher[0], /if \(!started\) return;/);
  assert.match(launcher[0], /catch \(error\) \{\s*toast\(error\.message, 'error'\)/);
  const starter = app.match(/async function startPi\([\s\S]*?\n}\nasync function stopPi/);
  assert.ok(starter);
  assert.match(starter[0], /finally \{ setBusy\(button, false\); renderPiSnapshot\(\); \}/);
});

test('resource restart preserves the active provider/model, harness, and thinking level', () => {
  const block = app.match(/async function restartPiForResources\(\)[\s\S]*?\n}\n\n\/\/ .*renderActiveModel/);
  assert.ok(block);
  assert.match(block[0], /app\.pi\.status\?\.modelId/);
  assert.match(block[0], /activeProvider.*activeProvider !== 'ollama'/s);
  assert.match(block[0], /app\.pi\.status\?\.harnessId \|\| selectedHarnessId\(\)/);
  assert.match(block[0], /thinkingLevel/);
  assert.match(block[0], /startPi\(restartSessionPath, restartSessionName, \{ harnessId, modelId, thinkingLevel \}\)/);
});

test('session launcher commits model defaults only after the live session transition succeeds', () => {
  const block = app.match(/async function applySessionLauncherSelection\(\)[\s\S]*?\n}\n\n\/\/ .*Model Selector/);
  assert.ok(block);
  assert.equal(block[0].includes('persistDefaultModelSelection'), false);
  assert.ok(block[0].indexOf('await switchModel(modelId)') < block[0].indexOf('await commitSessionLaunchChoices'));
  assert.ok(block[0].indexOf('const started = await startPi') < block[0].lastIndexOf('await commitSessionLaunchChoices'));
});

test('rejected prompts restore the draft and attachments and remove the optimistic bubble', () => {
  const block = app.match(/async function sendPrompt\(mode = 'prompt'\)[\s\S]*?\n}\n\nfunction switchView/);
  assert.ok(block);
  assert.match(block[0], /const submittedAttachments = \[\.\.\.app\.attachments\]/);
  assert.match(block[0], /optimisticMessage\?\.remove\?\.\(\)/);
  assert.match(block[0], /\$\('#composer'\)\.value = message/);
  assert.match(block[0], /app\.attachments = submittedAttachments/);
  assert.ok(block[0].indexOf('await rpc(command') < block[0].indexOf('app.promptHistory.unshift(message)'));
});

test('resource restart drops a stale session path instead of failing Pi startup', () => {
  const block = app.match(/async function restartPiForResources\(\)[\s\S]*?\n}\n\n\/\/ renderActiveModel/);
  assert.ok(block, 'restartPiForResources implementation missing');
  assert.match(block[0], /api\(`\/api\/session\/inspect\?workspace=\$\{enc\(app\.workspace\)\}&path=\$\{enc\(restartSessionPath\)\}`\)/);
  assert.match(block[0], /restartSessionPath = null/);
  assert.match(block[0], /startPi\(restartSessionPath, restartSessionName/);
});

test('Pi extensions inherit the active Studio Ollama runtime URL', () => {
  assert.match(piRpc, /PI_OLLAMA_BASE_URL: String\(cfg\.ollamaBaseUrl \|\| ''\)/);
  assert.match(piRpc, /PI_OLLAMA_BASE_URL[\s\S]*PI_OLLAMA_STUDIO_MCP_URL/);
  assert.match(piRpc, /PI_OLLAMA_STUDIO_URL/);
});

test('thinking selection is session state and never mutates model capability metadata', () => {
  const block = app.match(/\$\('#thinkingLevel'\)\.onchange = async \(\) => \{[\s\S]*?\n\};/);
  assert.ok(block, 'thinking selector handler missing');
  assert.match(block[0], /if \(!app\.pi\.status\?\.running\) return/);
  assert.match(block[0], /set_thinking_level/);
  assert.doesNotMatch(block[0], /toggle-reasoning/);
});


test('failed Test Connection never overwrites the active Ollama health/status', () => {
  const block=app.match(/async function testOllamaConnection\([\s\S]*?\n}\n\nasync function loadSessions/);
  assert.ok(block,'testOllamaConnection implementation missing');
  assert.match(block[0],/renderOllamaRuntimeStatus\(app\.ollama\)/);
  assert.match(block[0],/Active Ollama runtime was not changed/);
  assert.doesNotMatch(block[0],/ollamaRuntimeStatus'\); if \(node\).*Connection failed/);
});
