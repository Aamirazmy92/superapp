const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/editor.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-editor-'));
  const root = path.join(dataDir, 'project');
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  await fs.writeFile(path.join(root, 'src', 'nested', 'alpha.ts'), 'export const nested = 2;\n');
  await fs.writeFile(
    path.join(root, 'README.md'),
    '# Editor sample\n\nA small workspace to check the editor.\n',
  );
  await fs.writeFile(path.join(root, 'bom.txt'), '\uFEFFfirst\r\nsecond\r\n');
  await fs.writeFile(path.join(root, 'config.json'), '{"answer":42,"enabled":true}');
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({
      projects: [{ id: 'editor', name: 'Editor sample', root }],
      activeProject: 'editor',
      sessions: {},
    }),
  );
  const env = { ...process.env, SUPERAPP_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env,
  });
  const failures = [];
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => {
      failures.push(error.message);
      console.log('PAGE ERROR', error.stack);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.app').waitFor();
    await fs.mkdir('output/playwright', { recursive: true });
    const shot = (name) => page.screenshot({ path: `output/playwright/editor-${name}.png` });
    const edit = async (text) => {
      const editor = page.locator('.monaco-container .monaco-editor').last();
      await editor.click({ position: { x: 130, y: 45 } });
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(text);
      await page.getByRole('button', { name: 'Save changes', exact: true }).waitFor();
    };
    const open = async (name) => {
      await page.keyboard.press('Control+p');
      const dialog = page.getByRole('dialog', { name: 'Quick open file' });
      await dialog.waitFor();
      await page.getByLabel('Find file by name or path').fill(name);
      await dialog
        .getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
        .first()
        .waitFor();
      await page.keyboard.press('Enter');
      await dialog.waitFor({ state: 'hidden' });
      await page
        .locator('.editor-file-path')
        .filter({ hasText: name.replaceAll('/', ' / ') })
        .waitFor();
      await page.locator('.monaco-container .monaco-editor').last().waitFor();
    };
    const saved = () => page.getByRole('button', { name: 'Saved', exact: true }).waitFor();

    console.log('Step 1: explorer and keyboard navigation');
    console.log(await page.locator('body').ariaSnapshot());
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Project files' });
    await tree.getByRole('treeitem', { name: 'src', exact: true }).waitFor();
    assert.equal(
      await tree.getByRole('treeitem', { name: 'node_modules', exact: true }).count(),
      0,
    );
    await page.getByLabel('Show excluded folders').check();
    await tree.getByRole('treeitem', { name: 'node_modules', exact: true }).waitFor();
    await page.getByLabel('Show excluded folders').uncheck();
    await tree.getByRole('treeitem', { name: 'src', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await tree.getByRole('treeitem', { name: 'alpha.ts', exact: true }).waitFor();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.path), 'src/nested');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.locator('.monaco-container .monaco-editor').waitFor();
    await shot('01-explorer');

    console.log('Step 2: drafts, disambiguated tabs, undo/redo, save all');
    await edit('// alpha draft');
    console.log('Draft alpha entered');
    await open('src/nested/alpha.ts');
    console.log('Nested file opened');
    await tree.getByRole('treeitem', { name: 'nested', exact: true }).waitFor();
    assert.equal(
      await tree
        .getByRole('treeitem', { name: 'nested', exact: true })
        .getAttribute('aria-expanded'),
      'true',
    );
    await edit('// nested draft');
    console.log('Draft nested entered');
    await page.getByRole('tab', { name: 'src/alpha.ts, unsaved changes', exact: true }).click();
    assert.match(await page.locator('.monaco-container .view-lines').innerText(), /alpha\sdraft/);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    console.log('Undo clicked');
    assert.doesNotMatch(
      await page.locator('.monaco-container .view-lines').innerText(),
      /alpha\sdraft/,
    );
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.match(await page.locator('.monaco-container .view-lines').innerText(), /alpha\sdraft/);
    await page.getByRole('button', { name: 'Save changes', exact: true }).waitFor();
    await page.keyboard.press('Control+Shift+s');
    await saved();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Save all files"]').disabled,
    );
    assert.match(await fs.readFile(path.join(root, 'src', 'alpha.ts'), 'utf8'), /alpha draft/);
    assert.match(
      await fs.readFile(path.join(root, 'src', 'nested', 'alpha.ts'), 'utf8'),
      /nested draft/,
    );
    await page.getByRole('button', { name: 'Find in file', exact: true }).click();
    console.log(await page.locator('.monaco-container').ariaSnapshot());
    const find = page.getByRole('dialog', { name: 'Find / Replace' });
    await find.getByRole('textbox', { name: 'Find', exact: true }).fill('draft');
    await find.getByRole('textbox', { name: 'Replace', exact: true }).fill('amended');
    await page.mouse.move(540, 430);
    await page.locator('.monaco-hover:visible').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => {
      const widget = document.querySelector('.find-widget.visible');
      if (!widget) return false;
      const transform = getComputedStyle(widget).transform;
      return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
    });
    await shot('02-find-replace');
    await find.getByRole('button', { name: 'Replace All (Ctrl+Alt+Enter)', exact: true }).click();
    assert.match(await page.locator('.monaco-container .view-lines').innerText(), /alpha\samended/);
    await find.getByRole('textbox', { name: 'Find', exact: true }).focus();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Word wrap', exact: true }).click();
    assert.equal(
      await page
        .getByRole('button', { name: 'Word wrap', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );

    console.log('Step 3: UTF-8 BOM and CRLF preservation');
    await open('bom.txt');
    assert.match(await page.locator('.editor-status').innerText(), /CRLF/);
    await edit('third');
    await page.keyboard.press('Control+s');
    await saved();
    assert.equal(
      await fs.readFile(path.join(root, 'bom.txt'), 'utf8'),
      '\uFEFFfirst\r\nsecond\r\nthird',
    );

    console.log('Step 4: cancel, save and close, discard');
    await edit(' draft');
    await page.getByRole('button', { name: 'Close bom.txt', exact: true }).click();
    let close = page.getByRole('dialog', { name: 'Save changes to bom.txt?' });
    await close.getByRole('button', { name: 'Cancel', exact: true }).click();
    await close.waitFor({ state: 'hidden' });
    assert.equal(
      await page.getByRole('tab', { name: 'bom.txt, unsaved changes', exact: true }).count(),
      1,
    );
    await page.getByRole('button', { name: 'Close bom.txt', exact: true }).click();
    await close.getByRole('button', { name: 'Save and close', exact: true }).click();
    await page.getByRole('tab', { name: /^bom.txt/ }).waitFor({ state: 'hidden' });
    assert.match(await fs.readFile(path.join(root, 'bom.txt'), 'utf8'), /third draft$/);
    await page.getByRole('tab', { name: 'nested/alpha.ts', exact: true }).click();
    await edit(' discard me');
    await page.getByRole('button', { name: 'Close nested/alpha.ts', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Save changes to alpha.ts?' })
      .getByRole('button', { name: 'Discard changes', exact: true })
      .click();
    assert.doesNotMatch(
      await fs.readFile(path.join(root, 'src', 'nested', 'alpha.ts'), 'utf8'),
      /discard me/,
    );

    console.log('Step 5: external conflicts stay editable and resolve safely');
    await page.getByRole('tab', { name: /^alpha\.ts(?:, unsaved changes)?$/ }).click();
    await edit(' local change');
    await fs.writeFile(path.join(root, 'src', 'alpha.ts'), 'export const external = 3;\n');
    await page.keyboard.press('Control+s');
    await page.getByRole('button', { name: 'Keep my edits', exact: true }).waitFor();
    await edit(' merged');
    await shot('03-conflict');
    await page.getByRole('button', { name: 'Keep my edits', exact: true }).click();
    await page
      .getByRole('button', { name: 'Keep my edits', exact: true })
      .waitFor({ state: 'hidden' });
    await saved();
    assert.match(
      await fs.readFile(path.join(root, 'src', 'alpha.ts'), 'utf8'),
      /local change merged/,
    );
    await edit(' replace me');
    await fs.writeFile(path.join(root, 'src', 'alpha.ts'), 'export const disk = 4;\n');
    await page.keyboard.press('Control+s');
    await page.getByRole('button', { name: 'Use disk version', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Use the disk version?' })
      .getByRole('button', { name: 'Use disk version', exact: true })
      .click();
    await page.getByRole('dialog', { name: 'Use the disk version?' }).waitFor({ state: 'hidden' });
    await saved();
    await page.waitForFunction(() =>
      document.querySelector('.monaco-container .view-lines')?.textContent.includes('disk'),
    );
    assert.match(await page.locator('.monaco-container .view-lines').innerText(), /disk\s=\s4/);

    console.log('Step 6: formatting and folder rename preserve drafts');
    await open('config.json');
    const format = page.getByRole('button', { name: 'Format document', exact: true });
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Format document"]').disabled,
    );
    await format.click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await saved();
    assert.match(await fs.readFile(path.join(root, 'config.json'), 'utf8'), /\n/);
    await page.getByRole('tab', { name: 'alpha.ts', exact: true }).click();
    await edit('// rename draft');
    await page.getByRole('button', { name: 'Manage src', exact: true }).click();
    const manage = page.getByRole('dialog', { name: 'Manage file or folder' });
    await manage.getByLabel('File or folder path').fill('source');
    await manage.getByRole('button', { name: 'Rename / move', exact: true }).click();
    await manage.waitFor({ state: 'hidden' });
    await page.locator('.editor-file-path').filter({ hasText: 'source / alpha.ts' }).waitFor();
    assert.match(await page.locator('.monaco-container .view-lines').innerText(), /rename\sdraft/);
    await page.keyboard.press('Control+s');
    await saved();
    assert.match(await fs.readFile(path.join(root, 'source', 'alpha.ts'), 'utf8'), /rename draft/);
    await page.getByRole('button', { name: 'Collapse all folders' }).click();
    await tree
      .getByRole('treeitem', { name: 'alpha.ts', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(await tree.locator('[role="treeitem"][tabindex="0"]').count(), 1);
    await page.getByRole('button', { name: 'New file', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New file', exact: true });
    assert.equal(await create.getByLabel('File or folder path').inputValue(), 'source/');
    await create.getByLabel('File or folder path').fill('source/new.ts');
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await create.waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: 'new.ts', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'alpha.ts', exact: true }).click();
    await page.locator('.editor-file-path').filter({ hasText: 'source / alpha.ts' }).waitFor();
    await shot('04-editor');

    console.log('Step 7: project text search opens the matching line');
    await page.getByRole('button', { name: 'Find files', exact: true }).click();
    await page.getByRole('button', { name: 'File contents', exact: true }).click();
    await page.getByLabel('Search project', { exact: true }).fill('disk =');
    await page.locator('.content-result').first().waitFor();
    await page.locator('.content-result').first().click();
    await page.waitForFunction(() =>
      document.querySelector('.editor-status').textContent.includes('Ln 1, Col 14'),
    );
    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await tree.getByRole('treeitem', { name: 'alpha.ts', exact: true }).waitFor();
    assert.equal(
      await tree
        .getByRole('treeitem', { name: 'source', exact: true })
        .getAttribute('aria-expanded'),
      'true',
    );
    await page.setViewportSize({ width: 1024, height: 720 });
    await shot('05-compact');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(async () => {
      const saved = await window.workspace.bootstrap();
      return saved.sessions.editor?.activeFile === 'source/alpha.ts';
    });
    await page.evaluate(() => {
      const key = 'superapp.preferences.v1';
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...value, theme: 'light', reduceMotion: true }));
    });
    await page.reload();
    await page.getByRole('tab', { name: 'alpha.ts', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'alpha.ts', exact: true }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('.monaco-container .monaco-editor').waitFor();
    await page.waitForFunction(() => document.querySelector('.monaco-container .view-lines')?.textContent.includes('disk'));
    await shot('06-light');
    assert.deepEqual(failures, []);
    console.log(
      'PASS: editor navigation, drafts, history, saves, conflicts, encoding, formatting, rename, creation, search and compact/light layouts',
    );
  } catch (error) {
    const page = await app.firstWindow();
    console.log(await page.locator('body').ariaSnapshot());
    await page.screenshot({ path: 'output/playwright/editor-failure.png' });
    throw error;
  } finally {
    // This isolated fixture deliberately leaves drafts during failure checks.
    // Destroy only its windows so the native unsaved-close prompt cannot hang cleanup.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
    );
    await app.close();
    if (
      !path.resolve(dataDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(dataDir).startsWith('superapp-editor-')
    )
      throw new Error('Unsafe test cleanup target');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
