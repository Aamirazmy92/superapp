const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listAgents, catalog } = require('../electron/agents.cjs');

const ext = process.platform === 'win32' ? '.cmd' : '';
async function bin(t, ...commands) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp agents '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const command of commands)
    await fs.writeFile(path.join(dir, command + ext), '', { mode: 0o755 });
  return dir;
}
const byId = (agents) => Object.fromEntries(agents.map((agent) => [agent.id, agent]));

test('agent catalog ids and commands are unique', () => {
  const ids = catalog.map((agent) => agent.id);
  assert.equal(new Set(ids).size, ids.length);
  const primary = catalog.flatMap((agent) => agent.commands.slice(0, 1));
  assert.equal(new Set(primary).size, primary.length);
});

test('agents are detected from the given PATH directories', async (t) => {
  const dir = await bin(t, 'grok', 'agy', 'kiro-cli');
  const agents = byId(await listAgents([dir]));
  assert.equal(agents.grok.installed, true);
  assert.equal(agents.grok.executable, path.join(dir, 'grok' + ext));
  assert.equal(agents.antigravity.installed, true);
  assert.equal(agents.kiro.command, 'kiro-cli');
  assert.equal(agents.claude.installed, false);
  assert.equal(agents.terminal.installed, true);
});

test("Grok's bundled agent executable is not mistaken for Cursor Agent", async (t) => {
  const grok = await bin(t, 'grok', 'agent');
  assert.equal(byId(await listAgents([grok])).cursor.installed, false);

  const cursor = await bin(t, 'agent');
  assert.equal(byId(await listAgents([grok, cursor])).cursor.executable, path.join(cursor, 'agent' + ext));

  const alias = await bin(t, 'cursor-agent', 'agent');
  assert.equal(
    byId(await listAgents([grok, alias])).cursor.executable,
    path.join(alias, 'cursor-agent' + ext),
  );
});
