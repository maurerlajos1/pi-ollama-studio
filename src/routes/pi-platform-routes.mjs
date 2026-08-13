export function createPiPlatformRoutes({ readBody, json, sendEvent, resolveWorkspacePath, inspectPiPlatform, writePromptTemplate, writeSkill, writeContextFile, writePiSettings }) {
  return async function handlePiPlatformRoutes(req, res, url) {
    const { pathname, searchParams } = url;
    if (req.method === 'GET' && pathname === '/api/pi-platform') {
      const { root } = await resolveWorkspacePath(searchParams.get('workspace'), '.');
      json(res, 200, { ok: true, platform: await inspectPiPlatform(root) });
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/pi-platform/prompt') {
      const body = await readBody(req);
      const { root } = await resolveWorkspacePath(body.workspace, '.');
      const resource = await writePromptTemplate(root, body);
      sendEvent('pi_platform_changed', { workspace: root, kind: 'prompt', resource });
      json(res, 200, { ok: true, resource, platform: await inspectPiPlatform(root) });
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/pi-platform/skill') {
      const body = await readBody(req);
      const { root } = await resolveWorkspacePath(body.workspace, '.');
      const resource = await writeSkill(root, body);
      sendEvent('pi_platform_changed', { workspace: root, kind: 'skill', resource });
      json(res, 200, { ok: true, resource, platform: await inspectPiPlatform(root) });
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/pi-platform/context') {
      const body = await readBody(req);
      const { root } = await resolveWorkspacePath(body.workspace, '.');
      const resource = await writeContextFile(root, body);
      sendEvent('pi_platform_changed', { workspace: root, kind: 'context', resource });
      json(res, 200, { ok: true, resource, platform: await inspectPiPlatform(root) });
      return true;
    }
    if (req.method === 'PUT' && pathname === '/api/pi-platform/settings') {
      const body = await readBody(req);
      const { root } = await resolveWorkspacePath(body.workspace, '.');
      const resource = await writePiSettings(root, body);
      sendEvent('pi_platform_changed', { workspace: root, kind: 'settings', resource: { scope: resource.scope, path: resource.path } });
      json(res, 200, { ok: true, resource, platform: await inspectPiPlatform(root) });
      return true;
    }
    return false;
  };
}
