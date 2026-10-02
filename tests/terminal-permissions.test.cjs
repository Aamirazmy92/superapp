const assert = require('node:assert/strict');
const test = require('node:test');
const { selectCodexFullAccess } = require('../electron/terminal-permissions.cjs');

test('Codex permissions button selects and confirms Full Access', async () => {
  const writes = [];
  let listener;
  const proc = {
    onData(callback) {
      listener = callback;
      return { dispose() { listener = undefined; } };
    },
    write(data) {
      writes.push(data);
      if (writes.length === 2) {
        listener('\x1b[2JUpdate Model Permissions\r\n  4. Full Access');
      } else if (data === '\x1b[F') {
        listener('\x1b[1G› 4. Full Access');
      } else if (writes.length === 4) {
        listener('Enable full access?');
      } else if (writes.length === 5) {
        listener('Permissionselectionrequested:FullAccess');
      }
    },
  };

  await selectCodexFullAccess(proc);
  assert.deepEqual(writes, ['/permissions', '\r', '\x1b[F', '\r', '\r']);
  assert.equal(listener, undefined);
});

test('Codex permissions button closes the menu when Full Access is already active', async () => {
  const writes = [];
  let listener;
  const proc = {
    onData(callback) {
      listener = callback;
      return { dispose() { listener = undefined; } };
    },
    write(data) {
      writes.push(data);
      if (data === '\r') listener('Update Model Permissions › 4. Full Access (current)');
    },
  };

  await selectCodexFullAccess(proc);
  assert.deepEqual(writes, ['/permissions', '\r', '\x1b']);
  assert.equal(listener, undefined);
});
