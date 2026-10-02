const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron } = require('playwright');

// Run after npm run build: node tests/chat-coding.electron.cjs
// A native fixture executable exercises discovery, the actual Codex app-server
// adapter, IPC, attachments and UI. It never calls a model or an installed CLI.
// Windows ships the .NET compiler used here; no dependencies are installed.
const fixtureSource = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
class Fixture {
  static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
  static string thread = "fixture-session";
  static string turn = "fixture-turn";
  static string cwd;
  static string prompt;
  static bool waiting;
  static Dictionary<string, object> Obj(object value) { return (Dictionary<string, object>)value; }
  static string Text(Dictionary<string, object> value, string key) { return value.ContainsKey(key) ? Convert.ToString(value[key]) : ""; }
  static void Send(object value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
  static void Event(string method, object value) { Send(new { method = method, @params = value }); }
  static void Delta(string value) { Event("item/agentMessage/delta", new { threadId = thread, turnId = turn, itemId = "answer", delta = value }); }
  static void Complete(string answer) {
    Delta(answer);
    Event("item/completed", new { threadId = thread, turnId = turn, item = new { id = "answer", type = "agentMessage", text = answer } });
    Event("turn/completed", new { threadId = thread, turn = new { id = turn, status = "completed" } });
  }
  static void FinishApproval(bool accepted) {
    waiting = false;
    if (!accepted) { Complete("Change declined; the project was kept."); return; }
    string expected = Path.GetFullPath(Environment.GetEnvironmentVariable("SUPERAPP_FIXTURE_PROJECT"));
    if (!String.Equals(Path.GetFullPath(cwd), expected, StringComparison.OrdinalIgnoreCase)) throw new Exception("Fixture refused unexpected project path.");
    string target = Path.Combine(expected, "example.ts");
    string diff = "-export const answer = 1;\n+export const answer = 42;";
    Event("item/started", new { threadId = thread, turnId = turn, item = new { id = "edit", type = "fileChange", status = "inProgress", changes = new[] { new { path = target, kind = "update", diff = diff } } } });
    File.WriteAllText(target, "export const answer = 42;\n");
    Event("item/completed", new { threadId = thread, turnId = turn, item = new { id = "edit", type = "fileChange", status = "completed", changes = new[] { new { path = target, kind = "update", diff = diff } } } });
    Event("item/started", new { threadId = thread, turnId = turn, item = new { id = "check", type = "commandExecution", command = "fixture-check example.ts", cwd = cwd, status = "inProgress" } });
    Event("item/completed", new { threadId = thread, turnId = turn, item = new { id = "check", type = "commandExecution", command = "fixture-check example.ts", cwd = cwd, status = "completed", aggregatedOutput = "Fixture check passed", exitCode = 0 } });
    Complete("Updated example.ts to 42. Fixture check passed.");
  }
  static void Main() {
    string line;
    while ((line = Console.ReadLine()) != null) {
      File.AppendAllText(Environment.GetEnvironmentVariable("SUPERAPP_FIXTURE_LOG"), line + "\n");
      var message = Obj(json.DeserializeObject(line));
      string method = Text(message, "method");
      if (method == "") {
        if (waiting && message.ContainsKey("result")) FinishApproval(Text(Obj(message["result"]), "decision").StartsWith("accept"));
        continue;
      }
      if (method == "initialized") continue;
      var p = message.ContainsKey("params") ? Obj(message["params"]) : new Dictionary<string, object>();
      object result = new {};
      if (method == "model/list") result = new { data = new[] { new { id = "fixture-model", model = "fixture-model", displayName = "Fixture coding model", isDefault = true, supportedReasoningEfforts = new[] { new { reasoningEffort = "medium" } }, defaultReasoningEffort = "medium" } } };
      if (method == "thread/start" || method == "thread/resume") {
        if (method == "thread/resume") thread = Text(p, "threadId");
        cwd = Text(p, "cwd");
        result = new { thread = new { id = thread } };
      }
      if (method == "turn/start") { result = new { turn = new { id = turn } }; cwd = Text(p, "cwd"); }
      if (message.ContainsKey("id")) Send(new { id = message["id"], result = result });
      if (method != "turn/start") continue;
      prompt = json.Serialize(p["input"]);
      if (prompt.Contains("stop fixture")) {
        Event("item/started", new { threadId = thread, turnId = turn, item = new { id = "waiting-check", type = "commandExecution", command = "fixture-wait", cwd = cwd, status = "inProgress" } });
        Delta("Partial coding response");
        continue;
      }
      if (prompt.Contains("change code")) {
        waiting = true;
        Send(new { id = 10001, method = "item/commandExecution/requestApproval", @params = new { threadId = thread, turnId = turn, itemId = "approval", command = "Update example.ts and run fixture-check", reason = "Fixture requests permission to change example.ts" } });
        continue;
      }
      Complete("Follow-up continued in the same coding session.");
    }
  }
}`;

(async () => {
  if (process.platform !== 'win32') throw new Error('This native Codex fixture requires Windows.');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-chat-coding-'));
  const projectRoot = path.join(dataDir, 'project');
  const fixtureDir = path.join(dataDir, 'fixture-bin');
  const logFile = path.join(dataDir, 'protocol.jsonl');
  let app;
  let fixtureMainPid;
  let currentPage;
  let phase = 'compile fixture';
  const diagnostics = [];
  const closeFixture = async () => {
    if (!app) return;
    let timer;
    try {
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            // The renderer may be unavailable after a startup failure and
            // therefore unable to acknowledge the app's graceful close.
            try { if (fixtureMainPid) process.kill(fixtureMainPid); } catch {}
            try { app.process().kill(); } catch {}
            resolve();
          }, 5000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  };
  try {
    await fs.mkdir(projectRoot);
    await fs.mkdir(fixtureDir);
    await fs.writeFile(path.join(projectRoot, 'example.ts'), 'export const answer = 1;\n');
    await fs.writeFile(path.join(dataDir, 'workspaces.json'), JSON.stringify({
      projects: [{ id: 'coding-fixture', name: 'Coding fixture', root: projectRoot }],
      activeProject: 'coding-fixture', sessions: {},
    }));
    const sourceFile = path.join(fixtureDir, 'Fixture.cs');
    const executable = path.join(fixtureDir, 'codex.exe');
    await fs.writeFile(sourceFile, fixtureSource);
    await promisify(execFile)(path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
      ['/nologo', '/target:exe', `/out:${executable}`, '/reference:System.Web.Extensions.dll', sourceFile],
      { windowsHide: true });
    const env = { ...process.env, SUPERAPP_DATA_DIR: dataDir,
      SUPERAPP_FIXTURE_PROJECT: projectRoot, SUPERAPP_FIXTURE_LOG: logFile };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${fixtureDir}${path.delimiter}${env[pathKey] || ''}`;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SUPERAPP_DEV_URL;
    const launch = async () => {
      const launched = await _electron.launch({ executablePath: require('electron'), args: [path.resolve('.')], env });
      fixtureMainPid = await launched.evaluate(() => process.pid);
      launched.process().stdout?.on('data', (chunk) => diagnostics.push(`stdout: ${chunk}`));
      launched.process().stderr?.on('data', (chunk) => diagnostics.push(`stderr: ${chunk}`));
      launched.on('close', () => diagnostics.push(`App closed during ${phase}`));
      return launched;
    };
    phase = 'launch';
    app = await launch();
    const page = currentPage = await app.firstWindow();
    const consoleErrors = [];
    page.on('pageerror', (error) => { consoleErrors.push(error.message); diagnostics.push(`pageerror: ${error.message}`); });
    page.on('console', (message) => diagnostics.push(`console ${message.type()}: ${message.text()}`));
    phase = 'open chat and discover fixture model';
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.evaluate(() => {
      window.fixtureActivityEvents = [];
      window.workspace.onChatActivity((event) => window.fixtureActivityEvents.push(event));
    });
    await fs.mkdir(path.join('output', 'playwright'), { recursive: true });
    await page.screenshot({ path: 'output/playwright/chat-coding-startup.png' });
    await page.getByRole('combobox', { name: 'Chat model' }).getByText('Fixture coding model').waitFor();
    assert.equal((await page.evaluate(() => window.workspace.bootstrap())).terminals.length, 0, 'fixture starts without interactive terminals');
    phase = 'upload attachments';
    await page.getByRole('button', { name: 'New chat' }).click();
    const input = page.locator('.chat-attachment-input');
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzL0AAAAASUVORK5CYII=';
    const code = 'export const attached = "fixture source";\n';
    await input.setInputFiles([
      { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
      { name: 'notes.ts', mimeType: 'text/plain', buffer: Buffer.from(code) },
      { name: 'remove-me.txt', mimeType: 'text/plain', buffer: Buffer.from('remove this') },
    ]);
    await page.getByRole('button', { name: 'Remove attachment reference.png', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove attachment notes.ts', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove attachment remove-me.txt', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Remove attachment remove-me.txt', exact: true }).count(), 0);
    // Native paste/drop events exercise the same browser File APIs as a user.
    await message.evaluate((element, base64) => {
      const clipboardData = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      clipboardData.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, png);
    await page.getByRole('button', { name: 'Remove attachment pasted.png', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove attachment pasted.png', exact: true }).click();
    await page.locator('.chat-composer').evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['export const dropped = true;'], 'dropped.ts', { type: 'text/plain' }));
      element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    });
    await page.getByRole('button', { name: 'Remove attachment dropped.ts', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove attachment dropped.ts', exact: true }).click();
    await fs.mkdir(path.join('output', 'playwright'), { recursive: true });
    await page.screenshot({ path: 'output/playwright/chat-coding-attachments.png' });
    phase = 'deny edit approval';
    await message.fill('change code from these references');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await page.locator('.chat-message.assistant:not(.streaming)').getByText('Change declined; the project was kept.').waitFor();
    assert.equal(await fs.readFile(path.join(projectRoot, 'example.ts'), 'utf8'), 'export const answer = 1;\n');
    phase = 'approve edit and inspect activities';
    await message.fill('change code approved');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await page.locator('.chat-message.assistant:not(.streaming)').getByText('Updated example.ts to 42. Fixture check passed.').waitFor();
    assert.equal(await fs.readFile(path.join(projectRoot, 'example.ts'), 'utf8'), 'export const answer = 42;\n');
    // Steps collapse into one summary line; expand it, then the edit step.
    const steps = page.locator('.chat-message.assistant:not(.streaming) .chat-activities').last();
    await steps.locator('.chat-activities-summary').getByText('Edited example.ts, ran a command').waitFor();
    await page.screenshot({ path: 'output/playwright/chat-coding-steps.png' });
    await steps.locator('.chat-activities-summary').click();
    await steps.locator('.chat-activity').filter({ hasText: 'fixture-check' }).first().waitFor();
    const editCard = steps.locator('.chat-activity').filter({ hasText: 'example.ts' }).first();
    await editCard.locator('summary').click();
    await editCard.locator('.chat-diff-row.add').filter({ hasText: 'export const answer = 42;' }).waitFor();
    await editCard.locator('.chat-diff-row.del').filter({ hasText: 'export const answer = 1;' }).waitFor();
    await page.screenshot({ path: 'output/playwright/chat-coding-changes.png' });
    await page.locator('.chat-changes-summary').getByText('1 file changed').waitFor();
    await page.getByRole('button', { name: 'Review changes' }).click();
    const review = page.getByRole('dialog', { name: 'Changes in this response' });
    await review.getByRole('button', { name: /example\.ts/ }).waitFor();
    await review.locator('.chat-diff-row.add').filter({ hasText: '42' }).waitFor();
    await page.screenshot({ path: 'output/playwright/chat-coding-review.png' });
    await review.getByRole('button', { name: 'Close Changes in this response' }).click();
    await review.waitFor({ state: 'detached' });
    await page.locator('.chat-header-changes').getByText('1 file').waitFor();
    await editCard.getByRole('button', { name: /example\.ts Open file/ }).click();
    await page.locator('.app-body .monaco-editor').waitFor();
    await page.waitForFunction(() => document.querySelector('.app-body .monaco-editor .view-lines')?.textContent.includes('42'));
    await page.screenshot({ path: 'output/playwright/chat-coding-editor.png' });
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    phase = 'cancel response and resume session';
    // Cancellation retains partial output and the early provider session ID.
    await page.getByRole('button', { name: 'New chat' }).click();
    await message.fill('stop fixture');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.locator('.chat-message.assistant.streaming').getByText('Partial coding response').waitFor();
    await page.getByRole('button', { name: 'Stop response' }).click();
    await page.locator('.chat-message.assistant:not(.streaming)').getByText('Partial coding response').waitFor();
    const stopped = page.locator('.chat-message.assistant:not(.streaming) .chat-activities').last();
    await stopped.locator('.chat-activities-failed').getByText('1 failed').waitFor();
    await stopped.locator('.chat-activities-summary').click();
    await stopped.locator('.chat-activity.failed').filter({ hasText: 'fixture-wait' }).waitFor();
    await message.fill('follow-up after stopping');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.locator('.chat-message.assistant:not(.streaming)').getByText('Follow-up continued in the same coding session.').waitFor();
    const protocol = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse);
    const turns = protocol.filter((entry) => entry.method === 'turn/start');
    assert.equal(turns.length, 4);
    assert.ok(turns[0].params.input.some((item) => item.type === 'image' && item.url === `data:image/png;base64,${png}`));
    assert.ok(turns[0].params.input.some((item) => item.type === 'text' && item.text.includes(code.trim())), 'text attachment reaches the agent as source data');
    assert.ok(!JSON.stringify(turns[0]).includes('remove this'), 'removed attachments must not be sent');
    assert.equal(protocol.filter((entry) => entry.method === 'thread/resume').length, 2, 'follow-ups resume after success and cancellation');
    assert.ok(protocol.some((entry) => entry.result?.decision === 'decline'));
    assert.ok(protocol.some((entry) => entry.result?.decision === 'accept'));
    await input.setInputFiles({ name: 'draft.ts', mimeType: 'text/plain', buffer: Buffer.from('unsent draft reference') });
    await page.getByRole('button', { name: 'Remove attachment draft.ts', exact: true }).waitFor();
    const waitForSaved = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const value = JSON.parse(await fs.readFile(path.join(dataDir, 'chats.json'), 'utf8'));
          if (value.threads.length === 2 && value.threads.some((t) => t.draftAttachments?.length === 1 && t.messages.some((m) => m.content === 'Follow-up continued in the same coding session.'))) return value;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Completed coding conversations were not saved.');
    };
    const saved = await waitForSaved();
    const initial = saved.threads.find((t) => t.title.includes('change code'));
    assert.equal(initial.messages[0].attachments.length, 2);
    assert.ok(initial.messages[0].attachments.every((attachment) => attachment.id && !attachment.data && !attachment.content));
    assert.ok(initial.messages.some((m) => m.activities?.some((activity) => activity.kind === 'file')));
    assert.ok(!JSON.stringify(saved).includes(png), 'image bytes are stored separately from chat history');
    assert.equal(saved.threads.find((t) => t.title === 'stop fixture').sessionId, 'fixture-session');
    assert.deepEqual(consoleErrors, []);
    phase = 'restart and inspect persistence';
    await closeFixture();
    app = await launch();
    const reopened = currentPage = await app.firstWindow();
    await reopened.locator('.app').waitFor();
    await reopened.getByRole('button', { name: 'Chat', exact: true }).click();
    await reopened.locator('.chat-thread-open', { hasText: 'change code from these references' }).click();
    await reopened.locator('.chat-activities-summary').filter({ hasText: 'example.ts' }).first().waitFor();
    assert.equal(await reopened.locator('.chat-message.user').first().getByText('reference.png', { exact: true }).count(), 1);
    assert.equal(await reopened.getByRole('button', { name: 'Remove attachment draft.ts', exact: true }).count(), 0, 'draft attachments belong to their conversation');
    await reopened.locator('.chat-thread-open', { hasText: 'stop fixture' }).click();
    await reopened.getByRole('button', { name: 'Remove attachment draft.ts', exact: true }).waitFor();
    console.log('Coding chat attachments, real adapter protocol, approvals, project edits, activities, cancellation, resumption and persistence passed.');
  } catch (error) {
    await fs.mkdir(path.join('output', 'playwright'), { recursive: true });
    if (currentPage && !currentPage.isClosed()) {
      await currentPage.screenshot({ path: 'output/playwright/chat-coding-failure.png' }).catch(() => {});
      diagnostics.push(`UI: ${await currentPage.locator('body').innerText().catch(String)}`);
      diagnostics.push(`Activity events: ${JSON.stringify(await currentPage.evaluate(() => window.fixtureActivityEvents).catch(String))}`);
    }
    diagnostics.push(`Saved chats: ${await fs.readFile(path.join(dataDir, 'chats.json'), 'utf8').catch(String)}`);
    diagnostics.push(`Protocol: ${await fs.readFile(logFile, 'utf8').catch(String)}`);
    await fs.writeFile('output/playwright/chat-coding-debug.log', `Phase: ${phase}\n${diagnostics.join('\n')}`);
    console.error(`Coding fixture failed during ${phase}; diagnostics: output/playwright/chat-coding-debug.log`);
    throw error;
  } finally {
    await closeFixture();
    if (!path.resolve(dataDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(dataDir).startsWith('superapp-chat-coding-'))
      throw new Error('Refusing to remove a directory outside the isolated coding fixture.');
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
