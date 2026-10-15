const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright');

// Run after npm run build: node tests/chat-stream.electron.cjs
(async () => {
  let stopAttempts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/tags')
      return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
    if (req.url !== '/api/chat') {
      res.statusCode = 404;
      return res.end();
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.stream, true);
    const stopping = request.messages.at(-1).content === 'stop';
    res.setHeader('Content-Type', 'application/x-ndjson');
    if (request.messages.at(-1).content === 'format') {
      const content =
        '**Bold**\n\n```ts\nconst x = 1;\n```\n\n[Docs](https://example.com)\n\n![hidden](https://example.com/image.png)';
      return res.end(`${JSON.stringify({ message: { content }, done: false })}\n{"done":true}\n`);
    }
    if (stopping && ++stopAttempts === 1) {
      res.write('{"message":{"content":"Partial"},"done":false}\n');
      return;
    }
    if (stopping)
      return res.end('{"message":{"content":"Retried response"},"done":false}\n{"done":true}\n');
    res.write('{"message":{"content":"First"},"done":false}\n');
    await new Promise((resolve) => setTimeout(resolve, 600));
    res.end('{"message":{"content":" response"},"done":false}\n{"done":true}\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-chat-stream-'));
  const launch = () =>
    _electron.launch({
      executablePath: require('electron'),
      args: [path.resolve('.')],
      env: { ...process.env, VEYO_DATA_DIR: dataDir },
    });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('combobox', { name: 'Chat provider' }).click();
    await page.getByRole('option', { name: /^Ollama/ }).click();
    await page.locator('.chat-layout').getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByLabel('Ollama server address')
      .fill(`http://127.0.0.1:${server.address().port}`);
    await page
      .getByRole('dialog', { name: 'Chat settings' })
      .getByLabel('Chat model')
      .fill('test-model');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.locator('.chat-message.assistant.streaming').getByText('First').waitFor();
    await page
      .locator('.chat-message.assistant:not(.streaming)')
      .getByText('First response')
      .waitFor();
    assert.equal(await page.locator('.chat-message.assistant.streaming').count(), 0);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('stop');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.locator('.chat-message.assistant.streaming').getByText('Partial').waitFor();
    await page.getByRole('button', { name: 'Stop response' }).click();
    await page.locator('.chat-message.assistant:not(.streaming)').getByText('Partial').waitFor();
    await page.getByRole('button', { name: 'Retry response' }).click();
    await page
      .locator('.chat-message.assistant:not(.streaming)')
      .getByText('Retried response')
      .waitFor();
    assert.equal(await page.locator('.chat-message.assistant:not(.streaming)').count(), 2);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('format');
    await page.getByRole('button', { name: 'Send message' }).click();
    const formatted = page.locator('.chat-message.assistant:not(.streaming)').last();
    await formatted.locator('strong', { hasText: 'Bold' }).waitFor();
    assert.equal(await formatted.locator('pre code').textContent(), 'const x = 1;\n');
    assert.equal(await formatted.getByRole('button', { name: 'Copy code' }).count(), 1);
    assert.equal(await formatted.getByRole('link', { name: 'Docs' }).count(), 1);
    assert.equal(await formatted.locator('img').count(), 0);
    assert.match(
      await page.evaluate(() => window.workspace.openExternal('javascript:alert(1)').catch(String)),
      /Only web links/,
    );
    await fs.mkdir(path.join('output', 'playwright'), { recursive: true });
    await page.screenshot({ path: 'output/playwright/chat-markdown.png' });
    console.log('Streaming, stop, retry and safe Markdown rendering passed.');
    // Chats are saved by the main process, not in origin-bound localStorage.
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => localStorage.getItem('chat-threads')), null);
    await app.close();
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'chats.json'), 'utf8'));
    assert.equal(saved.threads.length, 1);
    assert.equal(saved.threads[0].title, 'hello');
    assert.equal(saved.settings.provider, 'ollama');
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.locator('.app').waitFor();
    await reopened.getByRole('button', { name: 'Chat', exact: true }).click();
    await reopened.locator('.chat-thread-open', { hasText: 'hello' }).click();
    await reopened
      .locator('.chat-message.assistant:not(.streaming)')
      .getByText('Retried response')
      .waitFor();
    await reopened.locator('.chat-layout').getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(
      await reopened.getByLabel('Ollama server address').inputValue(),
      `http://127.0.0.1:${server.address().port}`,
    );
    console.log('Chats and chat settings persisted across restart.');
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
    if (
      !path.resolve(dataDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(dataDir).startsWith('veyo-chat-stream-')
    )
      throw new Error('Refusing to remove a directory outside the test profile.');
    // Electron can hold profile files briefly after close on Windows.
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
