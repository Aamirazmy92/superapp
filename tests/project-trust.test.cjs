const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { claudeConfigFiles, claudeSettingsDecision } = require('../electron/project-trust.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo trust '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a project without Claude configuration has nothing to trust', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'README.md'), 'hi');
  assert.deepEqual(await claudeConfigFiles(root), []);
});

test('lists the Claude configuration a project brings', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.claude'));
  await fs.writeFile(path.join(root, 'CLAUDE.md'), 'rules');
  await fs.writeFile(path.join(root, '.mcp.json'), '{}');
  assert.deepEqual(await claudeConfigFiles(root), ['.claude', 'CLAUDE.md', '.mcp.json']);
});

test('only the saved values count as a decision', () => {
  assert.equal(claudeSettingsDecision({ claudeSettings: 'trusted' }), 'trusted');
  assert.equal(claudeSettingsDecision({ claudeSettings: 'ignored' }), 'ignored');
  assert.equal(claudeSettingsDecision({ claudeSettings: true }), null);
  assert.equal(claudeSettingsDecision({}), null);
});
