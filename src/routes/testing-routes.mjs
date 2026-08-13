export function createTestingRoutes({ readBody, json, sendEvent, resolveWorkspacePath, discoverTests, runTests, discoverRunConfigurations }) {
  return async function handleTestingRoutes(req, res, url) {
    const { pathname, searchParams } = url;
    if (req.method === 'GET' && pathname === '/api/tests/discover') {
      const { root } = await resolveWorkspacePath(searchParams.get('workspace'), '.');
      json(res, 200, { ok: true, discovery: await discoverTests(root) });
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/tests/run') {
      const body = await readBody(req);
      const { root } = await resolveWorkspacePath(body.workspace, '.');
      const result = await runTests(root, { target: body.target || null, testName: body.testName || '', mode: body.mode || 'all', timeoutMs: body.timeoutMs });
      sendEvent('test_result', { workspace: root, target: body.target || null, testName: body.testName || '', result });
      json(res, 200, { ok: true, result });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/run-configurations') {
      const { root } = await resolveWorkspacePath(searchParams.get('workspace'), '.');
      json(res, 200, { ok: true, ...(await discoverRunConfigurations(root)) });
      return true;
    }
    return false;
  };
}
