const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/chat-files.electron.cjs
// The chat's right-hand column, like Claude Code's: a Terminal pane and the
// Files pane (tabs and an editor beside the tree), opened from the title bar,
// stacked when both are open, with draggable widths and split.
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-chat-files-'));
  const project = path.join(dataDir, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(project, 'notes.txt'), 'remember the milk\n');
  await fs.writeFile(path.join(project, '.gitignore'), 'dist\n');
  await fs.writeFile(path.join(project, 'src', 'app.ts'), 'export const answer = 1;\n');
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({ projects: [{ id: 'p', name: 'Fixture project', root: project }], activeProject: 'p', sessions: {} }),
  );
  const thread = {
    id: 't', title: 'New chat', provider: 'claude', model: 'default', permission: 'ask',
    projectId: 'p', messages: [], draft: '', updatedAt: Date.now(),
  };
  await fs.writeFile(
    path.join(dataDir, 'chats.json'),
    JSON.stringify({ threads: [thread], active: 't', settings: { provider: 'claude', model: 'default' } }),
  );
  const env = { ...process.env, VEYO_DATA_DIR: dataDir };
  // `claude` stays off PATH so no chat process can start; PowerShell stays reachable for the terminal.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  env[pathKey] = [
    path.join(systemRoot, 'System32'),
    systemRoot,
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ].join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VEYO_DEV_URL;
  const artifacts = path.resolve('output/playwright');
  await fs.mkdir(artifacts, { recursive: true });
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve('.')], env });
  const read = (...parts) => fs.readFile(path.join(project, ...parts), 'utf8');
  const until = async (check, what) => {
    for (let i = 0; i < 80; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.fail(`Timed out waiting for ${what}`);
  };
  try {
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    // The column's size is remembered between runs; start wide enough for editor and tree side by side.
    await page.evaluate(() => {
      localStorage.setItem('chat-side-layout', JSON.stringify({ width: 640, split: 0.45 }));
      // Sizes from dragging are remembered; start every run from the defaults.
      localStorage.removeItem('chat-files-tree-width');
      localStorage.removeItem('chat-sidebar-width');
    });
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const bar = page.locator('.titlebar');
    const filesToggle = bar.getByRole('button', { name: 'Project files', exact: true });
    const terminalToggle = bar.getByRole('button', { name: 'Chat terminal', exact: true });
    // Open states are remembered between runs; start from closed.
    for (const toggle of [filesToggle, terminalToggle]) {
      await toggle.waitFor();
      if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    }
    const side = page.locator('.chat-side');
    const files = page.locator('section.chat-files');
    const terminal = page.locator('section.chat-terminal');
    const width = async (locator) => Math.round((await locator.boundingBox()).width);
    const height = async (locator) => Math.round((await locator.boundingBox()).height);

    // Files alone: the empty viewer beside the tree, Claude's placeholder and filter.
    await filesToggle.click();
    await files.waitFor();
    await files.getByText('Open files appear here').waitFor();
    await files.getByRole('treeitem', { name: '.gitignore' }).waitFor();
    const filter = files.getByRole('textbox', { name: 'Filter files' });
    assert.equal(await filter.getAttribute('placeholder'), 'Filter, or ? to search in files');
    for (const name of ['Search files', 'File tree', 'More file actions', 'Expand files', 'Close files'])
      await files.getByRole('button', { name, exact: true }).waitFor();
    // The chat's title and actions live in the title bar row, above the column, with no header line.
    const details = page.getByRole('button', { name: 'Session details' });
    assert.ok((await details.boundingBox()).y < 36, 'the chat actions are in the title bar');
    assert.ok((await page.locator('.chat-title').boundingBox()).y < 36, 'the chat title is in the title bar');
    assert.ok((await side.boundingBox()).y >= 36, 'the column starts below the title bar');
    assert.equal(await page.locator('.chat-header').count(), 0, 'no separate chat header');

    // Open two files as tabs; edit and save one with Ctrl+S.
    await files.getByRole('treeitem', { name: 'src' }).click();
    await files.getByRole('treeitem', { name: 'app.ts' }).click();
    await files.getByRole('treeitem', { name: 'README.md' }).click();
    const tabs = files.getByRole('tablist', { name: 'Open files' });
    await tabs.getByRole('tab', { name: /README\.md/ }).waitFor();
    await tabs.getByRole('tab', { name: /app\.ts/ }).click();
    const editor = files.locator('.monaco-editor').first();
    await editor.waitFor({ timeout: 20000 });
    await editor.locator('.view-lines').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('export const answer = 42;');
    await tabs.getByLabel('unsaved changes').waitFor();
    await page.keyboard.press('Control+S');
    await until(async () => (await read('src', 'app.ts')) === 'export const answer = 42;', 'the saved file');
    await files.getByText('Saved app.ts').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'chat-files-editing.png') });

    // Closing a tab with edits asks first; Discard keeps the saved file.
    await editor.locator('.view-lines').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('export const answer = 0;');
    await files.getByRole('button', { name: 'Close app.ts' }).click();
    const leave = files.getByRole('alertdialog', { name: 'Unsaved changes' });
    await leave.getByRole('button', { name: 'Cancel' }).click();
    await leave.waitFor({ state: 'detached' });
    await files.getByRole('button', { name: 'Close app.ts' }).click();
    await leave.getByRole('button', { name: 'Discard' }).click();
    await until(async () => (await tabs.getByRole('tab').count()) === 1, 'the tab to close');
    assert.equal(await read('src', 'app.ts'), 'export const answer = 42;');

    // A ? search inside files opens the match.
    await filter.fill('?milk');
    await files.getByRole('list', { name: 'Matches in files' }).getByRole('button', { name: /remember the milk/ }).click();
    await tabs.getByRole('tab', { name: /notes\.txt/ }).waitFor();
    await filter.fill('');

    // The tree toggle hides and shows the tree beside the editor.
    const treeToggle = files.getByRole('button', { name: 'File tree', exact: true });
    await treeToggle.click();
    await files.getByRole('textbox', { name: 'Filter files' }).waitFor({ state: 'detached' });
    await treeToggle.click();
    await filter.waitFor();

    // A disk change meanwhile is not overwritten silently.
    await tabs.getByRole('tab', { name: /notes\.txt/ }).click();
    await files.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('mine');
    await fs.writeFile(path.join(project, 'notes.txt'), 'changed elsewhere\n');
    await page.keyboard.press('Control+S');
    await files.getByRole('alert').filter({ hasText: 'Changed on disk' }).waitFor();
    assert.equal(await read('notes.txt'), 'changed elsewhere\n');
    await files.getByRole('button', { name: 'Keep my edits' }).click();
    await until(async () => (await read('notes.txt')).startsWith('mine'), 'the kept edits');

    // The terminal opens in the project folder and stacks above Files.
    await terminalToggle.click();
    await terminal.waitFor();
    await terminal.locator('.xterm').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await terminal.locator('.xterm').click();
    await page.keyboard.type('echo hello-from-chat');
    await page.keyboard.press('Enter');
    await until(
      () =>
        page.evaluate(async () => {
          const boot = await window.workspace.bootstrap();
          const chat = boot.terminals.filter((item) => item.workspaceName === 'Chat');
          const out = chat[0] && (await window.workspace.attachTerminal(chat[0].id, 'Chat'));
          return chat.length === 1 && !!out?.output.includes('hello-from-chat');
        }),
      'the terminal to run a command',
    );
    assert.ok((await terminal.boundingBox()).y < (await files.boundingBox()).y, 'terminal sits above files');
    await page.screenshot({ path: path.join(artifacts, 'chat-files-terminal.png') });

    // Drag: the tree handle widens the tree, the split moves, the column edge narrows it.
    const dragBy = async (locator, dx, dy) => {
      const box = await locator.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(250);
    };
    const tree = files.locator('.chat-files-columns > .chat-files-browser');
    const treeBefore = await width(tree);
    await dragBy(files.getByRole('separator', { name: 'Resize file tree' }), -40, 0);
    assert.ok((await width(tree)) > treeBefore + 25, 'the tree widens');
    const terminalBefore = await height(terminal);
    await dragBy(page.getByRole('separator', { name: 'Resize terminal and files' }), 0, 70);
    assert.ok((await height(terminal)) > terminalBefore + 50, 'the split moves');
    const columnBefore = await width(side);
    await dragBy(page.locator('.chat-side-handle.edge'), 150, 0);
    assert.ok((await width(side)) < columnBefore - 100, 'the column narrows');
    await page.screenshot({ path: path.join(artifacts, 'chat-files-dragged.png') });

    // The conversations sidebar can be dragged wider, and its handle has no coloured line.
    const sidebar = page.locator('.chat-sidebar');
    const sidebarBefore = await width(sidebar);
    await dragBy(page.getByRole('separator', { name: 'Resize conversations' }), 90, 0);
    assert.ok((await width(sidebar)) > sidebarBefore + 60, 'the sidebar widens');
    const handleColour = await page.getByRole('separator', { name: 'Resize terminal and files' }).evaluate((node) => {
      node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      return getComputedStyle(node, '::after').backgroundColor;
    });
    assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(handleColour), `handles are not highlighted: ${handleColour}`);

    // Expand gives one pane the whole column; restore brings both back.
    await files.getByRole('button', { name: 'Expand files' }).click();
    assert.equal(await terminal.isVisible(), false);
    await files.getByRole('button', { name: 'Restore files' }).click();
    await terminal.waitFor({ state: 'visible' });

    // The session details close the column, and the column closes the details.
    await details.click();
    await page.locator('aside.chat-rail').waitFor();
    assert.equal(await side.isVisible(), false);
    assert.equal(await terminalToggle.getAttribute('aria-pressed'), 'false');
    await filesToggle.click();
    await files.waitFor({ state: 'visible' });
    assert.equal(await page.locator('aside.chat-rail').count(), 0);

    // Hiding Files keeps its tabs; leave both panes closed for other tests.
    await filesToggle.click();
    await filesToggle.click();
    await tabs.getByRole('tab', { name: /notes\.txt/ }).waitFor();
    await files.getByRole('button', { name: 'Close files' }).click();
    // Opening the session details already closed the terminal pane.
    assert.equal(await terminal.isVisible(), false);
    await side.waitFor({ state: 'hidden' });
    assert.equal(await filesToggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await terminalToggle.getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => {
      for (const key of ['chat-side-layout', 'chat-files-tree-width', 'chat-sidebar-width']) localStorage.removeItem(key);
    });
  } finally {
    await app.close();
  }
  console.log('Chat side panes: files tabs, editor, tree, search, save, conflict, terminal, drag, expand and toggles passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
