import path from 'node:path';
import { APP_DIR, canonicalWorkspacePath, readJson, readJsonStrict, writeJsonAtomic } from './config.mjs';

const CHECKPOINTS_PATH = path.join(APP_DIR, 'checkpoints.json');
let checkpointWriteQueue = Promise.resolve();

function lexicalWorkspaceKey(workspace) {
  return path.resolve(String(workspace || ''));
}

async function canonicalKey(workspace) {
  return canonicalWorkspacePath(workspace, { allowMissing: true });
}

async function equivalentWorkspaceKeys(store, workspace) {
  const target = await canonicalKey(workspace);
  const matches = [];
  for (const key of Object.keys(store || {})) {
    if (key === target || key === lexicalWorkspaceKey(workspace)) { matches.push(key); continue; }
    const candidate = await canonicalWorkspacePath(key, { allowMissing: true }).catch(() => lexicalWorkspaceKey(key));
    if (candidate === target) matches.push(key);
  }
  return { target, matches: [...new Set(matches)] };
}

export async function listCheckpoints(workspace) {
  const store = await readJson(CHECKPOINTS_PATH, {});
  const { target, matches } = await equivalentWorkspaceKeys(store, workspace);
  const merged = {};
  for (const key of matches) Object.assign(merged, store[key] || {});
  if (store[target]) Object.assign(merged, store[target]);
  return merged;
}

export function recordCheckpoint(workspace, nodeId, checkpoint) {
  if (!workspace) return Promise.reject(new Error('Workspace is required'));
  if (!nodeId) return Promise.reject(new Error('Session node ID is required'));
  const operation = checkpointWriteQueue.then(async () => {
    const store = await readJsonStrict(CHECKPOINTS_PATH, {});
    const { target, matches } = await equivalentWorkspaceKeys(store, workspace);
    const existing = {};
    for (const key of matches) Object.assign(existing, store[key] || {});
    for (const key of matches) if (key !== target) delete store[key];
    store[target] = { ...existing, ...(store[target] || {}) };
    store[target][String(nodeId)] = {
      ...checkpoint,
      workspace: target,
      nodeId: String(nodeId),
      createdAt: checkpoint?.createdAt || new Date().toISOString()
    };
    await writeJsonAtomic(CHECKPOINTS_PATH, store);
    return store[target][String(nodeId)];
  });
  checkpointWriteQueue = operation.catch(() => {});
  return operation;
}

export async function getCheckpoint(workspace, nodeId) {
  const checkpoints = await listCheckpoints(workspace);
  return checkpoints[String(nodeId)] || null;
}

export const __test = { lexicalWorkspaceKey, equivalentWorkspaceKeys };
