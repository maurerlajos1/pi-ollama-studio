import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, gitCreateSnapshot, gitCreateWorktree, gitRemoveWorktree } from '../src/system.mjs';

test('Git checkpoints capture working state without mutating the live index and can create worktrees', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-studio-git-checkpoint-'));
  const repo = path.join(base, 'repo');
  const worktree = path.join(base, 'branch');
  await fs.mkdir(repo);
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });

  await runCommand('git', ['init', '-q'], { cwd: repo });
  await runCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await runCommand('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  await fs.mkdir(path.join(repo, '.pi', 'studio-sessions'), { recursive: true });
  await fs.writeFile(path.join(repo, '.gitignore'), '.pi/studio-sessions/\n');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'before\n');
  await runCommand('git', ['add', 'tracked.txt'], { cwd: repo });
  await runCommand('git', ['commit', '-qm', 'initial'], { cwd: repo });

  await fs.writeFile(path.join(repo, 'tracked.txt'), 'after\n');
  await fs.writeFile(path.join(repo, 'new.txt'), 'untracked snapshot file\n');
  await fs.writeFile(path.join(repo, '.pi', 'studio-sessions', 'active.jsonl'), '{"type":"session"}\n');
  const statusBefore = (await runCommand('git', ['status', '--porcelain'], { cwd: repo })).stdout;

  const snapshot = await gitCreateSnapshot(repo, 'test prompt checkpoint');
  assert.match(snapshot.commit, /^[0-9a-f]{40,64}$/);
  const statusAfter = (await runCommand('git', ['status', '--porcelain'], { cwd: repo })).stdout;
  assert.equal(statusAfter, statusBefore, 'snapshot must not alter the live index/worktree');

  const treeFiles = (await runCommand('git', ['ls-tree', '-r', '--name-only', snapshot.commit], { cwd: repo })).stdout;
  assert.doesNotMatch(treeFiles, /\.pi\/studio-sessions/, 'Studio session logs must not be captured in checkpoint commits');
  await assert.rejects(() => gitCreateWorktree(repo, path.join(repo, 'nested-worktree'), snapshot.commit, 'pi/nested'), /outside the current repository working tree/);

  // A lexically external target whose existing parent is a symlink/junction back
  // into the repository must be rejected by real filesystem containment too.
  const alias = path.join(base, 'repo-alias');
  try {
    await fs.symlink(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => gitCreateWorktree(repo, path.join(alias, 'escaped-worktree'), snapshot.commit, 'pi/symlink-escape'),
      /outside the current repository working tree/
    );
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'EISDIR') throw error;
  }

  await gitCreateWorktree(repo, worktree, snapshot.commit, 'pi/test-checkpoint');
  assert.equal((await fs.readFile(path.join(worktree, 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'after\n');
  assert.equal((await fs.readFile(path.join(worktree, 'new.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'untracked snapshot file\n');
});


test('gitRemoveWorktree rolls back a created worktree and temporary branch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-git-worktree-rollback-'));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'rollback-worktree');
  await fs.mkdir(repo, { recursive: true });
  await runCommand('git', ['init', '-q'], { cwd: repo });
  await runCommand('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  await runCommand('git', ['config', 'user.name', 'Pi Studio Test'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await runCommand('git', ['add', '.'], { cwd: repo });
  await runCommand('git', ['commit', '-qm', 'initial'], { cwd: repo });
  const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  await gitCreateWorktree(repo, worktree, head, 'pi/rollback-test');
  assert.equal((await fs.stat(worktree)).isDirectory(), true);
  await gitRemoveWorktree(repo, worktree, 'pi/rollback-test');
  await assert.rejects(() => fs.stat(worktree), (error) => error?.code === 'ENOENT');
  const branch = await runCommand('git', ['branch', '--list', 'pi/rollback-test'], { cwd: repo });
  assert.equal(branch.stdout.trim(), '');
});
