import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceSessionDir } from './config.mjs';

const MAX_INSPECT_BYTES = 50 * 1024 * 1024;

const WINDOWS_RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function sanitizeProjectDirectoryName(value) {
  let clean = String(value || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '');
  if (WINDOWS_RESERVED_BASENAMES.test(clean)) clean = `_${clean}`;
  clean = clean.slice(0, 120).replace(/[. ]+$/g, '');
  if (!clean || clean === '.' || clean === '..') throw new Error('Project name must be a normal directory name');
  return clean;
}

async function atomicWriteText(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

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
  return { path: file, size: stat.size, entries, tree: buildSessionTree(entries), errors };
}


function entryIdentity(entry) {
  return entry?.id || entry?.nodeId || entry?.messageId || null;
}

function entryParentIdentity(entry) {
  return entry?.parentId || entry?.parentNodeId || entry?.parentMessageId || null;
}

export function buildSessionTree(entries = []) {
  const nodes = (Array.isArray(entries) ? entries : []).map((entry) => ({ entry, children: [] }));
  const byId = new Map();
  for (const node of nodes) {
    const id = entryIdentity(node.entry);
    if (id != null && !byId.has(String(id))) byId.set(String(id), node);
  }

  const roots = [];
  for (const node of nodes) {
    const id = entryIdentity(node.entry);
    const parentId = entryParentIdentity(node.entry);
    const parent = parentId != null ? byId.get(String(parentId)) : null;
    let cyclic = false;
    if (parent && id != null) {
      const seen = new Set([String(id)]);
      let cursor = parent;
      while (cursor) {
        const cursorId = entryIdentity(cursor.entry);
        if (cursorId == null || !seen.add(String(cursorId))) { cyclic = true; break; }
        const nextParent = entryParentIdentity(cursor.entry);
        cursor = nextParent != null ? byId.get(String(nextParent)) : null;
      }
    }
    if (parent && parent !== node && !cyclic) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function branchEntriesToNode(entries, targetNodeId) {
  if (!targetNodeId) return [...entries];
  const byId = new Map();
  for (const entry of entries) {
    const id = entryIdentity(entry);
    if (id) byId.set(String(id), entry);
  }
  let current = byId.get(String(targetNodeId));
  if (!current) throw Object.assign(new Error(`Session node not found: ${targetNodeId}`), { statusCode: 404 });
  const keep = new Set();
  const seen = new Set();
  while (current) {
    const id = entryIdentity(current);
    if (!id || seen.has(String(id))) break;
    keep.add(String(id));
    seen.add(String(id));
    const parentId = current.parentId || current.parentNodeId || current.parentMessageId || null;
    current = parentId ? byId.get(String(parentId)) : null;
  }
  return entries.filter((entry, index) => index === 0 || (entryIdentity(entry) && keep.has(String(entryIdentity(entry)))));
}

export async function forkSession(workspace, sourceSessionPath, targetNodeId, newSessionName = '') {
  const { entries } = await inspectSession(workspace, sourceSessionPath);
  const dir = await resolveWorkspaceSessionDir(workspace, { create: true });

  const sliced = branchEntriesToNode(entries, targetNodeId);

  const newId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const newFileName = `${newId}.jsonl`;
  const targetFile = path.join(dir, newFileName);
  const resolvedName = newSessionName || `Fork of ${path.basename(sourceSessionPath, '.jsonl')}`;

  if (sliced.length > 0 && (sliced[0].type === 'session_header' || sliced[0].id)) {
    sliced[0] = {
      ...sliced[0],
      id: newId,
      name: resolvedName,
      parentSession: path.basename(sourceSessionPath)
    };
  }
  // Pi's latest session_info record is authoritative for display names. A
  // full clone can contain the source session's later rename, which would
  // otherwise override the new header and make the clone appear under the
  // old name. Keep the copied record shape/IDs, but rewrite its name.
  for (let index = 1; index < sliced.length; index++) {
    if (sliced[index]?.type === 'session_info') sliced[index] = { ...sliced[index], name: resolvedName };
  }

  const content = sliced.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await atomicWriteText(targetFile, content);

  return { ok: true, sessionId: newId, fileName: newFileName, path: targetFile };
}

export async function cloneSession(workspace, sourceSessionPath, newSessionName = '') {
  return forkSession(workspace, sourceSessionPath, null, newSessionName || `Clone of ${path.basename(sourceSessionPath, '.jsonl')}`);
}

export async function createProjectFromNode(sourceWorkspace, sourceSessionPath, targetNodeId, newProjectName, parentDir = '', { copyWorkspace = false } = {}) {
  if (!newProjectName || !newProjectName.trim()) throw new Error('Project name is required');
  const cleanName = sanitizeProjectDirectoryName(newProjectName);
  const sourceRoot = path.resolve(sourceWorkspace);
  const baseDir = parentDir ? path.resolve(parentDir) : path.dirname(sourceRoot);
  const newWorkspaceDir = path.join(baseDir, cleanName);

  // Validate the source session/node before mutating the filesystem. A bad node must
  // never leave a copied directory or partially-created project behind.
  const { entries } = await inspectSession(sourceWorkspace, sourceSessionPath);
  const sliced = branchEntriesToNode(entries, targetNodeId);

  let targetExisted = false;
  if (copyWorkspace) {
    const relToSource = path.relative(sourceRoot, newWorkspaceDir);
    if (!relToSource.startsWith('..') && !path.isAbsolute(relToSource)) throw new Error('Fallback project target must be outside the source workspace');
    const existing = await fs.stat(newWorkspaceDir).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    targetExisted = Boolean(existing);
    if (existing) {
      const existingEntries = existing.isDirectory() ? await fs.readdir(newWorkspaceDir) : ['not-a-directory'];
      if (existingEntries.length) throw new Error('Fallback project target already exists and is not empty');
    }
  }

  try {
    if (copyWorkspace) {
      await fs.cp(sourceRoot, newWorkspaceDir, {
        recursive: true,
        force: false,
        filter: (source) => {
          const rel = path.relative(sourceRoot, source);
          if (!rel) return true;
          const normalized = rel.split(path.sep).join('/');
          return normalized !== '.git' && !normalized.startsWith('.git/')
            && normalized !== 'node_modules' && !normalized.startsWith('node_modules/')
            && normalized !== '.pi/studio-sessions' && !normalized.startsWith('.pi/studio-sessions/');
        }
      });
    } else {
      await fs.mkdir(newWorkspaceDir, { recursive: true });
    }

    const agentsPath = path.join(newWorkspaceDir, 'AGENTS.md');
    try { await fs.access(agentsPath); }
    catch {
      const defaultContent = `# ${cleanName}\n\nProject created from Pi Session prompt node.\n\n## Instructions\n- Maintain clean architecture and test coverage.\n`;
      await atomicWriteText(agentsPath, defaultContent);
    }

    const targetSessionDir = await resolveWorkspaceSessionDir(newWorkspaceDir, { create: true });
    const newId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newFileName = `${newId}.jsonl`;
    const targetSessionFile = path.join(targetSessionDir, newFileName);
    if (sliced.length > 0) {
      sliced[0] = { ...sliced[0], id: newId, name: `${cleanName} Initial Session`, cwd: newWorkspaceDir };
    }
    const content = sliced.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await atomicWriteText(targetSessionFile, content);
    return { ok: true, projectName: cleanName, workspacePath: newWorkspaceDir, sessionPath: targetSessionFile };
  } catch (error) {
    if (copyWorkspace) {
      await fs.rm(newWorkspaceDir, { recursive: true, force: true }).catch(() => {});
      if (targetExisted) await fs.mkdir(newWorkspaceDir, { recursive: true }).catch(() => {});
    }
    throw error;
  }
}
