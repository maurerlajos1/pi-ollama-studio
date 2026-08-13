import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  inspectPiPlatform,
  writeContextFile,
  writePiSettings,
  writePromptTemplate,
  writeSkill,
  __test
} from '../src/pi-platform.mjs';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-platform-'));
  const workspace = path.join(base, 'repo', 'apps', 'web');
  const gitRoot = path.join(base, 'repo');
  const agentDir = path.join(base, 'agent-home');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(gitRoot, '.git'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'prompts'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'skills', 'global-review'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'extensions'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.pi', 'prompts'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.pi', 'skills', 'project-test'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.pi', 'extensions'), { recursive: true });
  await fs.mkdir(path.join(gitRoot, '.agents', 'skills', 'ancestor-skill'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'AGENTS.md'), '# Global\nGlobal instructions.\n');
  await fs.writeFile(path.join(gitRoot, 'AGENTS.md'), '# Repo\nRepository instructions.\n');
  await fs.writeFile(path.join(workspace, 'CLAUDE.md'), '# Web\nWeb-specific instructions.\n');
  await fs.writeFile(path.join(workspace, '.pi', 'APPEND_SYSTEM.md'), '# Extra\nBe precise.\n');
  await fs.writeFile(path.join(agentDir, 'prompts', 'review.md'), '---\ndescription: Review code\n---\nReview staged changes.\n');
  await fs.writeFile(path.join(workspace, '.pi', 'prompts', 'fix.md'), 'Fix the selected issue.\n');
  await fs.writeFile(path.join(agentDir, 'skills', 'global-review', 'SKILL.md'), '# Global Review\nUse for reviews.\n');
  await fs.writeFile(path.join(workspace, '.pi', 'skills', 'project-test', 'SKILL.md'), '# Project Test\nRun tests.\n');
  await fs.writeFile(path.join(gitRoot, '.agents', 'skills', 'ancestor-skill', 'SKILL.md'), '# Ancestor\nShared workflow.\n');
  await fs.writeFile(path.join(agentDir, 'extensions', 'global.ts'), 'export default function () {}\n');
  await fs.writeFile(path.join(workspace, '.pi', 'extensions', 'project.ts'), 'export default function () {}\n');
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark', nested: { a: 1, b: 1 }, packages: ['npm:global-pkg'] }));
  await fs.writeFile(path.join(workspace, '.pi', 'settings.json'), JSON.stringify({ nested: { b: 2 }, packages: [{ source: 'npm:project-pkg', skills: [] }] }));
  return { base, workspace, agentDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } };
}

test('inspectPiPlatform discovers documented Pi resource locations and settings hierarchy', async () => {
  const fx = await fixture();
  try {
    const value = await inspectPiPlatform(fx.workspace, { env: fx.env });
    assert.equal(value.agentDir, fx.agentDir);
    assert.ok(value.contextFiles.some((item) => item.scope === 'global' && item.name === 'AGENTS.md'));
    assert.ok(value.contextFiles.some((item) => item.scope === 'ancestor' && item.name === 'AGENTS.md'));
    assert.ok(value.contextFiles.some((item) => item.scope === 'project' && item.name === 'CLAUDE.md'));
    assert.ok(value.contextFiles.some((item) => item.kind === 'system-prompt' && item.name === 'APPEND_SYSTEM.md'));
    assert.ok(value.prompts.some((item) => item.name === 'review' && item.description === 'Review code'));
    assert.ok(value.prompts.some((item) => item.name === 'fix' && item.scope === 'project'));
    assert.ok(value.skills.some((item) => item.name === 'global-review'));
    assert.ok(value.skills.some((item) => item.name === 'project-test'));
    assert.ok(value.skills.some((item) => item.name === 'ancestor-skill' && item.scope === 'ancestor'));
    assert.ok(value.extensions.some((item) => item.name === 'global'));
    assert.ok(value.extensions.some((item) => item.name === 'project' && item.scope === 'project'));
    assert.equal(value.settings.effective.nested.a, 1);
    assert.equal(value.settings.effective.nested.b, 2);
    assert.equal(value.settings.rows.find((row) => row.key === 'nested.b').source, 'project');
    assert.ok(value.packages.some((item) => item.source === 'npm:global-pkg' && item.scope === 'global'));
    assert.ok(value.packages.some((item) => item.source === 'npm:project-pkg' && item.scope === 'project'));
    assert.ok(value.contextEstimate.persistentContextTokens > 0);
    assert.equal(value.trustSensitive, true);
  } finally { await fs.rm(fx.base, { recursive: true, force: true }); }
});

test('Pi platform writers stay inside documented roots and persist valid resources', async () => {
  const fx = await fixture();
  try {
    const prompt = await writePromptTemplate(fx.workspace, { scope: 'project', name: 'security-review', content: 'Review security.\n' }, { env: fx.env });
    assert.equal(await fs.readFile(prompt.path, 'utf8'), 'Review security.\n');
    assert.ok(prompt.path.includes(`${path.sep}.pi${path.sep}prompts${path.sep}`));

    const skill = await writeSkill(fx.workspace, { scope: 'global', name: 'release', content: '# Release\nValidate release.\n' }, { env: fx.env });
    assert.ok(skill.path.startsWith(path.join(fx.agentDir, 'skills')));
    assert.match(await fs.readFile(skill.path, 'utf8'), /Validate release/);

    const context = await writeContextFile(fx.workspace, { scope: 'project', name: 'AGENTS.md', content: '# Local\nUse npm test.\n' }, { env: fx.env });
    assert.equal(context.path, path.join(fx.workspace, 'AGENTS.md'));

    const settings = await writePiSettings(fx.workspace, { scope: 'project', settings: { enableSkillCommands: true, packages: ['npm:test'] } }, { env: fx.env });
    assert.deepEqual(JSON.parse(await fs.readFile(settings.path, 'utf8')), { enableSkillCommands: true, packages: ['npm:test'] });
    const temporaryArtifacts = (await fs.readdir(path.dirname(settings.path))).filter((name) => name.includes('.pi-studio-') && name.endsWith('.tmp'));
    assert.deepEqual(temporaryArtifacts, [], 'atomic Pi resource writes should not leave temporary files behind');

    await assert.rejects(() => writePromptTemplate(fx.workspace, { name: '../escape', content: 'x' }, { env: fx.env }), /unsupported characters/);
    await assert.rejects(() => writeContextFile(fx.workspace, { name: '.env', content: 'secret' }, { env: fx.env }), /Unsupported context/);
  } finally { await fs.rm(fx.base, { recursive: true, force: true }); }
});

test('Pi platform helpers parse frontmatter and merge nested settings deterministically', () => {
  const parsed = __test.parseFrontmatter('---\ndescription: "Do a thing"\n---\nBody\n');
  assert.equal(parsed.frontmatter.description, 'Do a thing');
  assert.equal(parsed.body, 'Body\n');
  assert.deepEqual(__test.deepMerge({ a: { x: 1, y: 1 }, p: [1] }, { a: { y: 2 }, p: [2] }), { a: { x: 1, y: 2 }, p: [2] });
  assert.equal(__test.settingsRows({ a: 1 }, { a: 2 })[0].source, 'project');
  assert.ok(__test.estimateTokens('abcd') >= 1);
});


test('Pi Platform settings mutation preserves corrupt existing settings', async (t) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pi-platform-corrupt-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const workspace=path.join(root,'work');await fs.mkdir(path.join(workspace,'.pi'),{recursive:true});const target=path.join(workspace,'.pi','settings.json');const raw='{"packages":[ BROKEN';await fs.writeFile(target,raw);
  await assert.rejects(()=>writePiSettings(workspace,{scope:'project',settings:{theme:'dark'}}),(error)=>error?.code==='JSON_STORE_CORRUPT');
  assert.equal(await fs.readFile(target,'utf8'),raw);
});
