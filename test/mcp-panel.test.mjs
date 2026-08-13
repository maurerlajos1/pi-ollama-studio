import test from 'node:test';
import assert from 'node:assert/strict';
import { __test, mcpFormState, parseCommandArguments } from '../public/mcp-panel.js';

test('MCP panel accepts JSON env/header objects and rejects non-object input', () => {
  assert.deepEqual(__test.parseJsonObject('{"TOKEN":"$TOKEN"}', 'Environment'), { TOKEN: '$TOKEN' });
  assert.throws(() => __test.parseJsonObject('[1]', 'Headers'), /JSON object/);
  assert.throws(() => __test.parseJsonObject('{', 'Headers'), /valid JSON/);
});

test('MCP stdio arguments preserve quoted paths without invoking a shell', () => {
  assert.deepEqual(
    parseCommandArguments('-y "@scope/pkg" "H:\\My Project" --label=\'hello world\''),
    ['-y', '@scope/pkg', 'H:\\My Project', '--label=hello world']
  );
  assert.deepEqual(parseCommandArguments('"" plain'), ['', 'plain']);
  assert.throws(() => parseCommandArguments('"broken'), /unterminated quote/);
});

test('MCP form requires an ID and transport-specific endpoint', () => {
  assert.deepEqual(mcpFormState(), { canSave: false });
  assert.deepEqual(mcpFormState({ id: 'fs', command: 'npx' }), { canSave: true });
  assert.deepEqual(mcpFormState({ id: 'remote', transport: 'http', url: 'https://example.test/mcp' }), { canSave: true });
  assert.deepEqual(mcpFormState({ id: 'remote', transport: 'http', url: 'file:///tmp/mcp' }), { canSave: false });
});
