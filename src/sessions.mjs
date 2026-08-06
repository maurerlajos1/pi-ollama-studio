import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceSessionDir } from './config.mjs';

const MAX_INSPECT_BYTES = 50 * 1024 * 1024;

async function readRange(file, position, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, position);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readHead(file, maxBytes = 65536) {
  return readRange(file, 0, maxBytes);
}

async function readTail(file, size, maxBytes = 262144) {
  const length = Math.min(size, maxBytes);
  return readRange(file, Math.max(0, size - length), length);
}

function parseJsonLines(text) {
  const result = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { result.push(JSON.parse(line)); } catch { /* partial head/tail records are expected */ }
  }
  return result;
}

function sessionMetadata(headText, tailText, fallbackId, workspace) {
  const headEntries = parseJsonLines(headText);
  const tailEntries = parseJsonLines(tailText);
  const header = headEntries[0] || {};
  const latestInfo = [...tailEntries].reverse().find((entry) => entry?.type === 'session_info');
  return {
    id: header.id || header.sessionId || fallbackId,
    name: latestInfo?.name ?? header.name ?? header.sessionName ?? header.title ?? '',
    cwd: header.cwd || header.workspace || workspace,
    parentSession: header.parentSession || null,
    version: header.version || null
  };
}

export async function listSessions(workspace) {
  let dir;
  try {
    dir = await resolveWorkspaceSessionDir(workspace, { create: false });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, entry.name);
    const stat = await fs.stat(file);
    const [head, tail] = await Promise.all([
      readHead(file).catch(() => ''),
      readTail(file, stat.size).catch(() => '')
    ]);
    const metadata = sessionMetadata(head, tail, entry.name.replace(/\.jsonl$/, ''), workspace);
    sessions.push({
      path: file,
      fileName: entry.name,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      createdAt: stat.birthtime.toISOString(),
      ...metadata
    });
  }
  return sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function inspectSession(workspace, sessionPath) {
  const dir = await resolveWorkspaceSessionDir(workspace, { create: false });
  const file = await fs.realpath(path.resolve(String(sessionPath || '')));
  const rel = path.relative(dir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('Session path is outside the selected workspace session directory'), { statusCode: 403 });
  }
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Session path is not a file');
  if (stat.size > MAX_INSPECT_BYTES) {
    throw Object.assign(new Error('Session is larger than the 50 MB inspection limit'), { statusCode: 413 });
  }
  const content = await fs.readFile(file, 'utf8');
  const entries = [];
  const errors = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch (error) { errors.push({ line: index + 1, error: error.message }); }
  }
  return { path: file, size: stat.size, entries, errors };
}
