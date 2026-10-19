const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { listAgents } = require('./agents.cjs');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function responseTooLarge() {
  return new Error('The agent response exceeds 2 MB. Ask for a smaller response.');
}

function abortError() {
  return Object.assign(new Error('Response stopped.'), { name: 'AbortError' });
}

function checkAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function attachmentText(attachment) {
  return `Attached file: ${attachment.name}\n${attachment.content}`;
}

function promptText(request) {
  // Old/stopped chats may have visible history without a provider session.
  if (request.sessionId || !Array.isArray(request.messages) || request.messages.length < 2)
    return request.prompt;
  const prior = request.messages
    .slice(0, -1)
    .filter(
      (message) =>
        ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string',
    )
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n')
    .slice(-150000);
  return prior
    ? `Previous conversation (context):\n${prior}\n\nCurrent request:\n${request.prompt}`
    : request.prompt;
}

function codexInput(request) {
  return [
    { type: 'text', text: promptText(request) },
    ...(request.attachments || []).flatMap((item) =>
      item.kind === 'image'
        ? [
            { type: 'text', text: `Attached image: ${item.name}` },
            { type: 'image', url: `data:${item.mimeType};base64,${item.data}` },
          ]
        : [{ type: 'text', text: attachmentText(item) }],
    ),
  ];
}

function claudeInput(request) {
  const content = [
    { type: 'text', text: promptText(request) },
    ...(request.attachments || []).flatMap((item) =>
      item.kind === 'image'
        ? [
            { type: 'text', text: `Attached image: ${item.name}` },
            {
              type: 'image',
              source: { type: 'base64', media_type: item.mimeType, data: item.data },
            },
          ]
        : [{ type: 'text', text: attachmentText(item) }],
    ),
  ];
  return (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: request.sessionId || '',
    };
  })();
}

async function executable(id) {
  const agent = (await listAgents()).find((item) => item.id === id);
  if (!agent?.executable)
    throw new Error(
      `${id === 'codex' ? 'Codex' : 'Claude Code'} is not installed or is not on PATH.`,
    );
  return agent.executable;
}

function validate(request) {
  if (
    !request ||
    !['codex', 'claude'].includes(request.provider) ||
    !['ask', 'auto', 'edits', 'plan', 'full'].includes(request.permission) ||
    typeof request.prompt !== 'string' ||
    !request.prompt.trim() ||
    request.prompt.length > 500000 ||
    typeof request.model !== 'string' ||
    request.model.length > 100 ||
    (request.effort != null &&
      (typeof request.effort !== 'string' || !/^[a-z]{2,20}$/.test(request.effort))) ||
    (request.sessionId != null &&
      (typeof request.sessionId !== 'string' || request.sessionId.length > 200))
  )
    throw new Error('Invalid agent chat request.');
  if (request.attachments != null) {
    if (!Array.isArray(request.attachments) || request.attachments.length > 8)
      throw new Error('Attach up to 8 files per message.');
    let total = 0;
    for (const item of request.attachments) {
      if (!item || typeof item.name !== 'string' || !item.name || item.name.length > 255)
        throw new Error('Invalid attachment name.');
      if (item.kind === 'image') {
        if (
          !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mimeType) ||
          typeof item.data !== 'string' ||
          !item.data ||
          item.data.length > 7 * 1024 * 1024 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)
        )
          throw new Error('Attach a PNG, JPEG, GIF, or WebP image up to 5 MB.');
        const size = Buffer.byteLength(item.data, 'base64');
        if (size > 5 * 1024 * 1024) throw new Error('Each image must be 5 MB or smaller.');
        total += size;
      } else if (item.kind === 'text') {
        if (
          typeof item.content !== 'string' ||
          Buffer.byteLength(item.content, 'utf8') > 1024 * 1024
        )
          throw new Error('Each text attachment must be 1 MB or smaller.');
        total += Buffer.byteLength(item.content, 'utf8');
      } else throw new Error('Unsupported attachment type.');
    }
    if (total > 20 * 1024 * 1024) throw new Error('Attachments must total 20 MB or less.');
  }
}

class CodexConnection {
  constructor(command, signal, onEvent, onApproval, options = {}) {
    checkAborted(signal);
    const { argsPrefix = [], ...spawnOptions } = options;
    this.child = spawn(command, [...argsPrefix, 'app-server'], {
      ...spawnOptions,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.pending = new Map();
    this.serial = 0;
    this.buffer = '';
    this.stderr = '';
    this.onEvent = onEvent;
    this.onApproval = onApproval;
    this.closed = false;
    this.signal = signal;
    this.decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(this.decoder.write(chunk)));
    this.child.stdout.on('end', () => this.consume(`${this.decoder.end()}\n`));
    this.child.stdin.on('error', (error) => this.close(error));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    this.child.on('error', (error) => this.close(error));
    this.child.on('exit', (code) =>
      this.close(new Error(this.stderr.trim() || `Codex app server exited (${code}).`)),
    );
    this.onAbort = () => {
      this.close(abortError());
      this.child.kill();
    };
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }
  close(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    this.signal?.removeEventListener('abort', this.onAbort);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.onEvent?.({ method: 'connection/closed', params: { error } });
  }
  write(value) {
    if (this.closed) throw new Error('Codex connection closed.');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  call(method, params = {}, timeout = 30000) {
    if (this.closed)
      return Promise.reject(this.closeError || new Error('Codex connection closed.'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Retry your message.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  consume(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value.id != null && !value.method) {
        const waiter = this.pending.get(value.id);
        if (!waiter) continue;
        this.pending.delete(value.id);
        clearTimeout(waiter.timer);
        if (value.error) waiter.reject(new Error(value.error.message || 'Codex request failed.'));
        else waiter.resolve(value.result);
      } else if (value.id != null && value.method) {
        Promise.resolve()
          .then(() => this.onApproval?.(value.method, value.params || {}))
          .then((result) =>
            this.write(
              result === undefined
                ? {
                    id: value.id,
                    error: { code: -32601, message: `Unsupported client request: ${value.method}` },
                  }
                : { id: value.id, result },
            ),
          )
          .catch((error) => {
            try {
              this.write({
                id: value.id,
                error: { code: -32603, message: error.message || 'Client request failed.' },
              });
            } catch {}
          });
      } else if (value.method) {
        try {
          this.onEvent?.(value);
        } catch (error) {
          this.close(error);
          this.child.kill();
        }
      }
    }
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.close(new Error('Codex sent an oversized protocol message.'));
      this.child.kill();
    }
  }
  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'veyo', title: 'Veyo', version: '0.1.0' },
    });
    this.write({ method: 'initialized' });
  }
  dispose() {
    this.close(new Error('Codex connection closed.'));
    this.child.kill();
  }
}

let codexModelsInFlight;
let claudeModelsInFlight;
let codexModelsCache;
let claudeModelsCache;
const MODEL_CACHE_TTL = 5 * 60 * 1000;
function claudeModelLabel(item) {
  const resolved = typeof item.resolvedModel === 'string' ? item.resolvedModel : item.value;
  const base = resolved.replace(/\[\d+m\]$/i, '').replace(/-\d{8}$/, '');
  const match = /^claude-(.+?)-(\d+)(?:-(\d+))?$/i.exec(base);
  if (!match) return item.displayName || item.value;
  const family = match[1]
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
  const context =
    /\[(\d+)m\]/i.exec(`${item.value} ${resolved}`)?.[1] ||
    /(\d+)M context/i.exec(item.displayName || '')?.[1];
  const name = `${family} ${match[2]}${match[3] ? `.${match[3]}` : ''}${context ? ` (${context}M context)` : ''}`;
  return item.value === 'default' ? `Default — ${name}` : name;
}
async function models(provider, endpoint, signal, force = false) {
  checkAborted(signal);
  if (provider === 'claude') {
    if (!force && claudeModelsCache && Date.now() - claudeModelsCache.at < MODEL_CACHE_TTL)
      return claudeModelsCache.data;
    if (!claudeModelsInFlight) {
      const task = (async () => {
        const command = await executable('claude');
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        // A streaming input keeps the SDK session open long enough to read its
        // account-aware model catalog without submitting a chat prompt.
        async function* idleInput() {
          await new Promise(() => {});
        }
        const controller = new AbortController();
        const session = query({
          prompt: idleInput(),
          options: {
            tools: [],
            abortController: controller,
            pathToClaudeCodeExecutable: command,
            strictMcpConfig: true,
            mcpServers: {},
            settings: { disableAllHooks: true },
          },
        });
        let timer;
        try {
          const available = await Promise.race([
            session.supportedModels(),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error('Claude model discovery timed out. Refresh models to try again.'));
              }, 15000);
            }),
          ]);
          const data = available
            .filter((item) => typeof item.value === 'string' && item.value)
            .map((item) => ({
              id: item.value,
              name: claudeModelLabel(item),
              efforts:
                item.supportsEffort === false
                  ? []
                  : item.supportedEffortLevels ||
                    (item.supportsEffort ? ['low', 'medium', 'high'] : []),
              isDefault: item.value === 'default',
            }));
          claudeModelsCache = { at: Date.now(), data };
          return data;
        } finally {
          clearTimeout(timer);
          session.close();
        }
      })();
      claudeModelsInFlight = task;
      task.then(
        () => {
          if (claudeModelsInFlight === task) claudeModelsInFlight = undefined;
        },
        () => {
          if (claudeModelsInFlight === task) claudeModelsInFlight = undefined;
        },
      );
    }
    return claudeModelsInFlight;
  }
  if (provider !== 'codex') throw new Error('Unknown provider.');
  if (!force && codexModelsCache && Date.now() - codexModelsCache.at < MODEL_CACHE_TTL)
    return codexModelsCache.data;
  if (!codexModelsInFlight) {
    const task = (async () => {
      const connection = new CodexConnection(await executable('codex'), signal);
      try {
        await connection.initialize();
        const available = [];
        const seen = new Set();
        let cursor;
        do {
          const result = await connection.call('model/list', {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          });
          for (const item of result.data || []) {
            const id = item.model || item.id;
            if (typeof id !== 'string' || !id || seen.has(id)) continue;
            seen.add(id);
            available.push({
              id,
              name: item.displayName || id,
              efforts: Array.isArray(item.supportedReasoningEfforts)
                ? item.supportedReasoningEfforts
                    .map((entry) => (typeof entry === 'string' ? entry : entry?.reasoningEffort))
                    .filter((effort) => typeof effort === 'string')
                : [],
              defaultEffort: item.defaultReasoningEffort || undefined,
              isDefault: item.isDefault === true,
            });
          }
          cursor = result.nextCursor;
        } while (cursor);
        codexModelsCache = { at: Date.now(), data: available };
        return available;
      } finally {
        connection.dispose();
      }
    })();
    codexModelsInFlight = task;
    task.then(
      () => {
        if (codexModelsInFlight === task) codexModelsInFlight = undefined;
      },
      () => {
        if (codexModelsInFlight === task) codexModelsInFlight = undefined;
      },
    );
  }
  return codexModelsInFlight;
}

function brief(value, length = 4000) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text || '').slice(-length);
}

function providerError(provider, detail) {
  detail = String(detail || `${provider} could not complete the response.`);
  if (
    /OAuth session expired|Failed to authenticate|authentication_failed|unauthorized|not authenticated|401/i.test(
      detail,
    )
  )
    return new Error(
      `${provider} sign-in expired. Run \`${provider === 'Codex' ? 'codex login' : 'claude auth login'}\` in a terminal, then retry.`,
    );
  return new Error(detail);
}

function waitFor(promise, signal, timeout = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const abort = () => finish(reject, abortError());
    const timer =
      timeout > 0
        ? setTimeout(
            () =>
              finish(
                reject,
                new Error('The agent stopped responding. Stop and retry your message.'),
              ),
            timeout,
          )
        : undefined;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal?.aborted) abort();
  });
}

const MAX_DIFF_LINES = 2000;
const MAX_DIFF_CHARS = 200 * 1024;

function splitLines(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Unified-style lines (`+`, `-`, ` ` and `@@` headers), capped so a large
// rewrite cannot bloat the saved chat history.
function fileChange(path, kind, lines) {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line[0] === '+') additions++;
    else if (line[0] === '-') deletions++;
  }
  let diff = lines.slice(0, MAX_DIFF_LINES).join('\n');
  const truncated = lines.length > MAX_DIFF_LINES || diff.length > MAX_DIFF_CHARS;
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS);
  return { path, kind, additions, deletions, diff, ...(truncated ? { truncated: true } : {}) };
}

// Small LCS line diff for edits reported only as old/new text.
function lineDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > 250000)
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i++]}`);
      j++;
    } else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1]))
      lines.push(`-${a[i++]}`);
    else lines.push(`+${b[j++]}`);
  }
  return lines;
}

function patchLines(structuredPatch) {
  if (!Array.isArray(structuredPatch)) return;
  const lines = [];
  for (const hunk of structuredPatch) {
    if (!hunk || !Array.isArray(hunk.lines)) return;
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines.filter((line) => typeof line === 'string'),
    );
  }
  return lines;
}

// Claude Code reports edits as tool input, then an exact patch in the result.
function claudeChanges(name, input, result) {
  const path = input.file_path || input.notebook_path;
  if (typeof path !== 'string') return;
  const patched = patchLines(result?.structuredPatch);
  const kind = result?.type === 'create' ? 'add' : 'update';
  if (patched?.length) return [fileChange(path, kind, patched)];
  if (name === 'Write')
    return [fileChange(path, kind, splitLines(input.content).map((line) => `+${line}`))];
  if (name === 'Edit') return [fileChange(path, 'update', lineDiff(input.old_string, input.new_string))];
  if (name === 'MultiEdit' && Array.isArray(input.edits))
    return [
      fileChange(
        path,
        'update',
        input.edits.flatMap((edit, index) => [
          ...(index ? ['@@'] : []),
          ...lineDiff(edit?.old_string, edit?.new_string),
        ]),
      ),
    ];
  if (name === 'NotebookEdit')
    return [
      fileChange(
        path,
        input.edit_mode === 'insert' ? 'add' : input.edit_mode === 'delete' ? 'delete' : 'update',
        splitLines(input.new_source).map((line) => `${input.edit_mode === 'delete' ? '-' : '+'}${line}`),
      ),
    ];
}

// Codex sends unified diffs for updates and raw content for added/deleted files.
function codexChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .filter((change) => typeof change?.path === 'string')
    .map((change) => {
      const type = typeof change.kind === 'string' ? change.kind : change.kind?.type;
      const kind = type === 'add' ? 'add' : type === 'delete' ? 'delete' : 'update';
      const lines = splitLines(change.diff).filter(
        (line) => !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith('diff --git') && !line.startsWith('index '),
      );
      const unified = lines.some((line) => line.startsWith('@@'));
      return fileChange(
        change.path,
        kind,
        unified || kind === 'update'
          ? lines
          : lines.map((line) => `${kind === 'delete' ? '-' : '+'}${line}`),
      );
    });
}

function codexActivity(item, completed) {
  if (!item?.id) return;
  const status =
    ['failed', 'declined', 'cancelled', 'interrupted'].includes(item.status) ||
    item.error ||
    item.success === false ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0)
      ? 'failed'
      : completed
        ? 'completed'
        : 'running';
  if (item.type === 'commandExecution')
    return {
      id: item.id,
      kind: 'command',
      title: brief(item.command || 'Run command', 200),
      detail: brief(item.aggregatedOutput || item.cwd),
      status,
    };
  if (item.type === 'fileChange') {
    const paths = (item.changes || [])
      .map((change) => change.path)
      .filter((path) => typeof path === 'string');
    return {
      id: item.id,
      kind: 'file',
      title: paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`,
      detail: brief(
        (item.changes || []).map((change) => `${change.path}\n${change.diff || ''}`).join('\n'),
      ),
      paths,
      changes: codexChanges(item.changes),
      status,
    };
  }
  if (
    ['mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch', 'imageView'].includes(
      item.type,
    )
  )
    return {
      id: item.id,
      kind: 'tool',
      title: brief(
        item.tool || item.query || (item.type === 'imageView' ? 'View image' : item.type),
        200,
      ),
      detail: brief(item.error || item.result || item.arguments || item.path),
      status,
    };
}

async function sendCodex(request, signal, onChunk, ask, onActivity, onSession, onUsageChanged) {
  checkAborted(signal);
  let threadId = request.sessionId;
  let turnId;
  let interrupting;
  let rejectCompletion;
  const activities = new Map();
  const command = await executable('codex');
  checkAborted(signal);
  const connection = new CodexConnection(command, undefined, null, async (method, params) => {
    const permissionRequest = method === 'item/permissions/requestApproval';
    const actionRequest = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ].includes(method);
    if (!permissionRequest && !actionRequest) {
      if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput')
        return { answers: {} };
      if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
      return undefined;
    }
    // Never approve another thread or a late request from a previous turn.
    if (params.threadId !== threadId || (turnId && params.turnId !== turnId) || signal.aborted)
      return permissionRequest ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
    const item = activities.get(params.itemId);
    const accepted = await waitFor(
      Promise.resolve().then(() =>
        ask({
          title: params.networkApprovalContext
            ? 'Allow network access?'
            : permissionRequest
              ? 'Allow additional access?'
              : method.includes('commandExecution')
                ? 'Run command?'
                : 'Approve file changes?',
          detail: [
            params.reason,
            params.command,
            params.cwd,
            permissionRequest ? brief(params.permissions) : undefined,
            params.networkApprovalContext ? brief(params.networkApprovalContext) : undefined,
            item?.detail || item?.title,
            params.grantRoot,
          ]
            .filter(Boolean)
            .join('\n')
            .slice(0, 8000),
        }),
      ),
      signal,
      5 * 60 * 1000,
    ).catch(() => false);
    if (permissionRequest)
      return { permissions: accepted ? params.permissions || {} : {}, scope: 'turn' };
    return { decision: accepted ? 'accept' : 'decline' };
  });
  let text = '';
  let textBytes = 0;
  let lastTextItem;
  let completed;
  let lastError;
  let idleTimer;
  let keepAlive;
  const messages = new Map();
  const addText = (itemId, delta) => {
    if (!delta) return;
    const output = (text && itemId !== lastTextItem ? '\n\n' : '') + delta;
    textBytes += Buffer.byteLength(output, 'utf8');
    if (textBytes > MAX_RESPONSE_BYTES) throw responseTooLarge();
    messages.set(itemId, (messages.get(itemId) || '') + delta);
    text += output;
    lastTextItem = itemId;
    onChunk(output);
  };
  const finishItem = (item) => {
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      const streamed = messages.get(item.id) || '';
      if (!streamed) addText(item.id, item.text);
      else if (item.text.startsWith(streamed) && item.text.length > streamed.length)
        addText(item.id, item.text.slice(streamed.length));
    }
    const activity = codexActivity(item, true);
    if (activity) {
      activities.set(activity.id, activity);
      onActivity(activity);
    }
  };
  const completion = new Promise((resolve, reject) => {
    rejectCompletion = reject;
    const alive = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => reject(new Error('Codex stopped responding. Retry your message.')),
        15 * 60 * 1000,
      );
    };
    keepAlive = alive;
    connection.onEvent = ({ method, params }) => {
      if (method === 'connection/closed') return reject(params.error);
      if (method === 'account/rateLimits/updated' || method === 'account/updated') {
        onUsageChanged();
        return;
      }
      if (
        params?.threadId !== threadId ||
        (turnId &&
          (params.turnId || params.turn?.id) &&
          (params.turnId || params.turn.id) !== turnId)
      )
        return;
      alive();
      if (method === 'turn/started' && params.turn?.id) turnId = params.turn.id;
      if (
        method === 'item/agentMessage/delta' &&
        params.threadId === threadId &&
        (!turnId || params.turnId === turnId) &&
        typeof params.delta === 'string'
      ) {
        addText(params.itemId || 'agent', params.delta);
      }
      if (method === 'error') lastError = params.error;
      if (method === 'item/started') {
        const activity = codexActivity(params.item, false);
        if (activity) {
          activities.set(activity.id, activity);
          onActivity(activity);
        }
      }
      if (method === 'item/completed') finishItem(params.item);
      if (method === 'item/commandExecution/outputDelta') {
        const activity = activities.get(params.itemId);
        if (activity && typeof params.delta === 'string') {
          const updated = {
            ...activity,
            detail: ((activity.detail || '') + params.delta).slice(-4000),
          };
          activities.set(updated.id, updated);
          onActivity(updated);
        }
      }
      if (
        method === 'turn/completed' &&
        params.threadId === threadId &&
        (!turnId || params.turn?.id === turnId)
      ) {
        completed = params.turn;
        for (const item of completed.items || []) finishItem(item);
        clearTimeout(idleTimer);
        resolve();
      }
    };
  });
  completion.catch(() => {});
  const onAbort = () => {
    // Interrupt the active turn before ending the server, so its command
    // cancellation and transcript cleanup can run. Never wait indefinitely.
    interrupting =
      threadId && turnId && !connection.closed
        ? connection
            .call('turn/interrupt', { threadId, turnId }, 1000)
            .catch(() => {})
            .finally(() => connection.dispose())
        : Promise.resolve().then(() => connection.dispose());
    rejectCompletion(abortError());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    checkAborted(signal);
    await connection.initialize();
    const policy = !request.projectId
      ? 'never'
      : request.permission === 'full'
        ? 'never'
        : request.permission === 'auto'
          ? 'untrusted'
          : 'on-request';
    const sandbox = !request.projectId
      ? 'read-only'
      : request.permission === 'full'
        ? 'danger-full-access'
        : 'workspace-write';
    const started = threadId
      ? await connection.call('thread/resume', {
          threadId,
          cwd: request.cwd,
          model: request.model || null,
          approvalPolicy: policy,
          sandbox,
        })
      : await connection.call('thread/start', {
          model: request.model || null,
          cwd: request.cwd,
          approvalPolicy: policy,
          sandbox,
          serviceName: 'veyo',
        });
    threadId = started.thread.id;
    await onSession(threadId);
    checkAborted(signal);
    const startedTurn = await connection.call('turn/start', {
      threadId,
      input: codexInput(request),
      cwd: request.cwd,
      model: request.model || null,
      ...(request.effort ? { effort: request.effort } : {}),
      approvalPolicy: policy,
      sandboxPolicy: {
        type: !request.projectId
          ? 'readOnly'
          : request.permission === 'full'
            ? 'dangerFullAccess'
            : 'workspaceWrite',
      },
    });
    turnId = startedTurn.turn.id;
    // Some servers finish a short turn before the turn/start response.
    if (!completed && ['completed', 'failed', 'interrupted'].includes(startedTurn.turn.status)) {
      completed = startedTurn.turn;
      for (const item of completed.items || []) finishItem(item);
    }
    if (!completed) {
      keepAlive();
      await completion;
    }
    checkAborted(signal);
    if (completed.status !== 'completed')
      throw providerError(
        'Codex',
        completed.error?.message ||
          lastError?.message ||
          (completed.status === 'interrupted'
            ? 'Codex response was interrupted.'
            : 'Codex did not complete the response.'),
      );
    if (!text.trim()) throw new Error('Codex returned no text.');
    return { text, sessionId: threadId };
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    clearTimeout(idleTimer);
    for (const activity of activities.values())
      if (activity.status === 'running')
        onActivity({
          ...activity,
          status: 'failed',
          detail: signal.aborted ? 'Stopped' : 'Agent ended before this action completed.',
        });
    if (interrupting) await interrupting;
    else connection.dispose();
  }
}

function claudeActivity(block) {
  if (block?.type !== 'tool_use') return;
  const input = block.input || {};
  const path = input.file_path || input.notebook_path;
  const kind =
    block.name === 'Bash'
      ? 'command'
      : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(block.name)
        ? 'file'
        : 'tool';
  return {
    id: block.id,
    kind,
    title: brief(
      kind === 'command'
        ? input.command || 'Run command'
        : kind === 'file'
          ? `${block.name} ${path || 'file'}`
          : block.name,
      200,
    ),
    detail: brief(input),
    status: 'running',
    ...(kind === 'file' && typeof path === 'string'
      ? { paths: [path], changes: claudeChanges(block.name, input) || [] }
      : {}),
  };
}

async function sendClaude(request, controller, onChunk, ask, onActivity, onSession, onUsageChanged) {
  checkAborted(controller.signal);
  const command = await executable('claude');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const options = {
    cwd: request.cwd,
    pathToClaudeCodeExecutable: command,
    abortController: controller,
    tools: request.projectId ? { type: 'preset', preset: 'claude_code' } : [],
    ...(request.projectId
      ? {
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          // A project's .claude settings can run hooks and pre-approve tools,
          // and the SDK skips Claude Code's folder trust prompt, so they load
          // only after the person trusted this project in Veyo.
          settingSources: request.trustProjectSettings === true ? ['user', 'project', 'local'] : ['user'],
        }
      : {
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          settings: { disableAllHooks: true },
        }),
    model: request.model === 'default' ? undefined : request.model,
    ...(request.effort ? { effort: request.effort } : {}),
    resume: request.sessionId || undefined,
    includePartialMessages: true,
    permissionMode: !request.projectId
      ? 'dontAsk'
      : request.permission === 'full'
        ? 'bypassPermissions'
        : { auto: 'auto', edits: 'acceptEdits', plan: 'plan' }[request.permission] || 'default',
    allowDangerouslySkipPermissions: !!request.projectId && request.permission === 'full',
    canUseTool: async (toolName, input, context = {}) => {
      if (!request.projectId || controller.signal.aborted || context.signal?.aborted)
        return {
          behavior: 'deny',
          message: 'This chat has no active project or has been stopped.',
        };
      const accepted = await waitFor(
        Promise.resolve().then(() =>
          ask({
            title: context.title || `Allow ${toolName}?`,
            detail: [context.decisionReason, context.blockedPath, JSON.stringify(input, null, 2)]
              .filter(Boolean)
              .join('\n')
              .slice(0, 8000),
          }),
        ),
        context.signal || controller.signal,
        5 * 60 * 1000,
      ).catch(() => false);
      return accepted
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'User declined this action.' };
    },
  };
  let text = '';
  let textBytes = 0;
  let streamMessageId = 'assistant';
  let streamMessageSerial = 0;
  let lastTextMessage;
  let lastFallbackMessage;
  let sessionId = request.sessionId;
  let fallback = '';
  const activities = new Map();
  const toolInputs = new Map();
  const seenAssistant = new Set();
  const session = query({ prompt: claudeInput(request), options });
  const iterator = session[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await waitFor(iterator.next(), controller.signal);
      if (next.done) break;
      const message = next.value;
      if (message.type === 'rate_limit_event') onUsageChanged();
      if (message.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
        await onSession(sessionId);
      }
      if (
        message.type === 'stream_event' &&
        !message.parent_tool_use_id &&
        message.event?.type === 'message_start'
      )
        streamMessageId = message.event.message?.id || `assistant-${++streamMessageSerial}`;
      if (
        message.type === 'stream_event' &&
        !message.parent_tool_use_id &&
        message.event?.type === 'content_block_delta' &&
        message.event.delta?.type === 'text_delta'
      ) {
        const delta = message.event.delta.text;
        if (!delta) continue;
        const output = (text && streamMessageId !== lastTextMessage ? '\n\n' : '') + delta;
        textBytes += Buffer.byteLength(output, 'utf8');
        if (textBytes > MAX_RESPONSE_BYTES) throw responseTooLarge();
        text += output;
        lastTextMessage = streamMessageId;
        onChunk(output);
      }
      if (message.type === 'assistant') {
        const blocks = message.message?.content || [];
        if (
          !message.parent_tool_use_id &&
          !seenAssistant.has(message.uuid || message.message?.id)
        ) {
          const completeText = blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
          const messageId = message.message?.id || message.uuid;
          const output =
            (fallback && completeText && messageId !== lastFallbackMessage ? '\n\n' : '') +
            completeText;
          if (
            Buffer.byteLength(fallback, 'utf8') + Buffer.byteLength(output, 'utf8') >
            MAX_RESPONSE_BYTES
          )
            throw responseTooLarge();
          fallback += output;
          if (completeText) lastFallbackMessage = messageId;
          seenAssistant.add(message.uuid || message.message?.id);
        }
        for (const block of blocks) {
          const activity = claudeActivity(block);
          if (activity?.kind === 'file') toolInputs.set(block.id, block);
          if (activity) {
            activities.set(activity.id, activity);
            onActivity(activity);
          }
        }
      }
      if (message.type === 'tool_progress') {
        const previous = activities.get(message.tool_use_id);
        const activity = previous || {
          id: message.tool_use_id,
          kind: 'tool',
          title: message.tool_name,
          status: 'running',
        };
        activities.set(activity.id, activity);
        onActivity(activity);
      }
      if (message.type === 'user') {
        if (
          !message.parent_tool_use_id &&
          Array.isArray(message.message?.content) &&
          message.message.content.some((block) => block.type === 'tool_result')
        )
          streamMessageId = `after-tool-${++streamMessageSerial}`;
        for (const block of message.message?.content || []) {
          if (block.type !== 'tool_result') continue;
          const previous = activities.get(block.tool_use_id);
          if (previous) {
            const detail = Array.isArray(block.content)
              ? block.content
                  .filter((item) => item.type === 'text')
                  .map((item) => item.text)
                  .join('\n')
              : block.content;
            const tool = toolInputs.get(block.tool_use_id);
            const changes =
              tool && !block.is_error
                ? claudeChanges(tool.name, tool.input || {}, message.tool_use_result)
                : undefined;
            const activity = {
              ...previous,
              status: block.is_error ? 'failed' : 'completed',
              detail: brief(detail),
              ...(changes ? { changes } : {}),
            };
            activities.set(activity.id, activity);
            onActivity(activity);
          }
        }
      }
      if (message.type === 'result' && message.is_error) {
        const detail =
          message.errors?.join(' ') || message.result || 'Claude could not complete the response.';
        throw providerError('Claude', detail);
      }
      if (message.type === 'result') {
        if (message.subtype?.startsWith('error'))
          throw providerError('Claude', message.errors?.join(' ') || message.subtype);
        if (!text.trim()) {
          text = message.result || fallback;
          if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw responseTooLarge();
          if (text) onChunk(text);
        }
        break;
      }
    }
    checkAborted(controller.signal);
    if (!text.trim() && fallback.trim()) {
      text = fallback;
      onChunk(text);
    }
    if (!text.trim()) throw new Error('Claude returned no text.');
    return { text, sessionId };
  } finally {
    for (const activity of activities.values())
      if (activity.status === 'running')
        onActivity({
          ...activity,
          status: 'failed',
          detail: controller.signal.aborted
            ? 'Stopped'
            : 'Agent ended before this action completed.',
        });
    session.close();
  }
}

async function send(
  request,
  controller,
  onChunk,
  ask,
  onActivity = () => {},
  onSession = () => {},
  onUsageChanged = () => {},
) {
  validate(request);
  const signal = controller.signal;
  return request.provider === 'codex'
    ? sendCodex(request, signal, onChunk, ask, onActivity, onSession, onUsageChanged)
    : sendClaude(request, controller, onChunk, ask, onActivity, onSession, onUsageChanged);
}

module.exports = { models, send, validate, CodexConnection };
