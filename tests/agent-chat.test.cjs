const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');

// Mock the process boundary and SDK, not the adapter. Node 22's ESM module
// mocking needs an experimental runner flag, so the VM supplies that loader.
function fixture({ handle, claudeMessages = [], query, now } = {}) {
  const wire = [];
  const children = [];
  const captures = {};
  const sdk = {
    query:
      query ||
      ((input) => {
        captures.claude = input;
        const session = (async function* () {
          yield* claudeMessages;
        })();
        session.close = () => {
          captures.closed = true;
        };
        return session;
      }),
  };
  function spawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.kills = 0;
    child.kill = () => {
      child.kills++;
    };
    child.stdin.write = (line) => {
      const request = JSON.parse(line);
      wire.push(request);
      queueMicrotask(() => {
        if (handle) return handle(request, child);
        if (request.method === 'initialize') reply(child, request, {});
        if (request.method === 'thread/start' || request.method === 'thread/resume')
          reply(child, request, { thread: { id: 'thread-1' } });
        if (request.method === 'turn/start') {
          reply(child, request, { turn: { id: 'turn-1', status: 'inProgress' } });
          completed(child, [{ type: 'agentMessage', id: 'answer', text: 'Done' }]);
        }
      });
      return true;
    };
    children.push(child);
    return child;
  }
  const context = {
    module: { exports: {} },
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    Date: class extends Date {
      static now() {
        return now ? now() : Date.now();
      }
    },
    loadClaudeSDK: async () => sdk,
    require: (id) =>
      id === 'node:child_process'
        ? { spawn }
        : id === './agents.cjs'
          ? {
              listAgents: async () => [
                { id: 'codex', executable: 'codex.exe' },
                { id: 'claude', executable: 'claude.exe' },
              ],
            }
          : require(id),
  };
  const source = fs
    .readFileSync(path.join(__dirname, '../electron/agent-chat.cjs'), 'utf8')
    .replaceAll("import('@anthropic-ai/claude-agent-sdk')", 'loadClaudeSDK()');
  vm.runInNewContext(source, context, { filename: 'agent-chat.cjs' });
  return { ...context.module.exports, wire, children, captures };
}
function reply(child, request, result) {
  child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}
function event(child, method, params = {}) {
  child.stdout.write(
    `${JSON.stringify({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } })}\n`,
  );
}
function completed(child, items = [], status = 'completed', error) {
  event(child, 'turn/completed', {
    turn: { id: 'turn-1', status, items, ...(error ? { error } : {}) },
  });
}
function request(overrides = {}) {
  return {
    provider: 'codex',
    permission: 'ask',
    prompt: 'Fix the app',
    model: 'test-model',
    cwd: 'D:\\project',
    projectId: 'project',
    ...overrides,
  };
}
function baseHandle(message, child) {
  if (message.method === 'initialize') reply(child, message, {});
  if (message.method === 'thread/start' || message.method === 'thread/resume')
    reply(child, message, { thread: { id: 'thread-1' } });
}

test('Codex forwards sparse account usage notifications before thread filtering', async () => {
  let updates = 0;
  const api = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method !== 'turn/start') return;
      reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
      child.stdout.write(
        JSON.stringify({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { primary: null } },
        }) + '\n',
      );
      child.stdout.write(
        JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } }) + '\n',
      );
      completed(child, [{ type: 'agentMessage', id: 'answer', text: 'Done' }]);
    },
  });
  await api.send(
    request(),
    new AbortController(),
    () => {},
    async () => true,
    () => {},
    () => {},
    () => updates++,
  );
  assert.equal(updates, 2);
});

test('Codex sends native images and text context and reports session before starting inference', async () => {
  const api = fixture();
  const sessions = [];
  const chunks = [];
  const result = await api.send(
    request({
      attachments: [
        { kind: 'image', name: 'design.png', mimeType: 'image/png', data: 'aGVsbG8=' },
        { kind: 'text', name: 'notes.txt', content: 'Use the blue header' },
      ],
    }),
    new AbortController(),
    (chunk) => chunks.push(chunk),
    async () => true,
    () => {},
    (id) => {
      sessions.push(id);
      assert.equal(
        api.wire.some((message) => message.method === 'turn/start'),
        false,
      );
    },
  );
  const turn = api.wire.find((message) => message.method === 'turn/start').params;
  assert.equal(
    turn.input.find((item) => item.type === 'image').url,
    'data:image/png;base64,aGVsbG8=',
  );
  assert.match(turn.input.at(-1).text, /notes.txt\nUse the blue header/);
  assert.equal(result.text, 'Done');
  assert.equal(chunks.join(''), 'Done');
  assert.deepEqual(sessions, ['thread-1']);
  assert.equal(api.children[0].kills, 1);
});

test('Codex emits command/file/tool progress and does not duplicate final streamed text', async () => {
  const api = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method !== 'turn/start') return;
      reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
      event(child, 'item/started', {
        item: { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'inProgress' },
      });
      event(child, 'item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'Tests passed' });
      event(child, 'item/completed', {
        item: {
          id: 'cmd',
          type: 'commandExecution',
          command: 'npm test',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'Tests passed',
        },
      });
      event(child, 'item/completed', {
        item: {
          id: 'edit',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'src/App.tsx', diff: '+ fixed' }],
        },
      });
      event(child, 'item/completed', {
        item: {
          id: 'tool',
          type: 'mcpToolCall',
          tool: 'read_docs',
          status: 'failed',
          error: 'Unavailable',
        },
      });
      event(child, 'item/agentMessage/delta', { itemId: 'answer', delta: 'Fixed' });
      const item = { id: 'answer', type: 'agentMessage', text: 'Fixed' };
      event(child, 'item/completed', { item });
      completed(child, [item]);
    },
  });
  const activities = [];
  const chunks = [];
  const result = await api.send(
    request(),
    new AbortController(),
    (chunk) => chunks.push(chunk),
    async () => true,
    (activity) => activities.push(activity),
  );
  assert.equal(result.text, 'Fixed');
  assert.equal(chunks.join(''), 'Fixed');
  assert.ok(activities.some((item) => item.id === 'cmd' && item.status === 'running'));
  assert.ok(
    activities.some(
      (item) => item.id === 'cmd' && item.status === 'completed' && item.detail === 'Tests passed',
    ),
  );
  assert.equal(activities.find((item) => item.id === 'edit').paths[0], 'src/App.tsx');
  assert.equal(activities.find((item) => item.id === 'tool').status, 'failed');
});

test('Codex approves scoped commands and permissions with the correct response shape', async () => {
  const api = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method === 'turn/start') {
        reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
        child.stdout.write(
          `${JSON.stringify({ id: 90, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', command: 'npm install', reason: 'Download dependencies' } })}\n`,
        );
      }
      if (message.id === 90 && message.result) {
        assert.equal(message.result.decision, 'accept');
        child.stdout.write(
          `${JSON.stringify({ id: 91, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', permissions: { network: { enabled: true } } } })}\n`,
        );
      }
      if (message.id === 91 && message.result) {
        assert.equal(message.result.permissions.network.enabled, true);
        assert.equal(message.result.scope, 'turn');
        completed(child, [{ id: 'answer', type: 'agentMessage', text: 'Approved' }]);
      }
    },
  });
  const prompts = [];
  await api.send(
    request(),
    new AbortController(),
    () => {},
    async (prompt) => {
      prompts.push(prompt);
      return true;
    },
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[0].detail, /npm install/);
  assert.match(prompts[1].detail, /network/);
});

test('Codex cancellation retains the learned session and releases abort listeners', async () => {
  const controller = new AbortController();
  const sessions = [];
  const api = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method === 'turn/start') {
        reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
        queueMicrotask(() => controller.abort());
      }
    },
  });
  await assert.rejects(
    api.send(
      request(),
      controller,
      () => {},
      async () => false,
      () => {},
      (id) => sessions.push(id),
    ),
    { name: 'AbortError' },
  );
  assert.deepEqual(sessions, ['thread-1']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.ok(api.children[0].kills >= 1);
});

test('Codex transport decodes split UTF-8, handles timeout and synchronous write failure', async () => {
  const api = fixture({ handle() {} });
  const events = [];
  const controller = new AbortController();
  const connection = new api.CodexConnection('codex.exe', controller.signal, (message) =>
    events.push(message),
  );
  const data = Buffer.from(JSON.stringify({ method: 'test', params: { text: 'café 🐈' } }) + '\n');
  for (const byte of data) connection.child.stdout.write(Buffer.from([byte]));
  assert.equal(events[0].params.text, 'café 🐈');
  await assert.rejects(connection.call('missing', {}, 10), /timed out/);
  assert.equal(connection.pending.size, 0);
  connection.child.stdin.write = () => {
    throw new Error('Pipe closed');
  };
  await assert.rejects(connection.call('write'), /Pipe closed/);
  assert.equal(connection.pending.size, 0);
  connection.dispose();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Codex applies fresh permissions on resume and keeps chats without a project read-only', async () => {
  const api = fixture();
  await api.send(
    request({ sessionId: 'old', projectId: undefined, permission: 'full' }),
    new AbortController(),
    () => {},
    async () => false,
  );
  const resume = api.wire.find((message) => message.method === 'thread/resume');
  assert.equal(resume.params.approvalPolicy, 'never');
  assert.equal(resume.params.sandbox, 'read-only');
  assert.equal(
    api.wire.find((message) => message.method === 'turn/start').params.sandboxPolicy.type,
    'readOnly',
  );
});

test('Claude native image input, tool lifecycle and result fallback use the SDK protocol', async () => {
  const api = fixture({
    claudeMessages: [
      { type: 'system', subtype: 'init', session_id: 'claude-session' },
      {
        type: 'assistant',
        uuid: 'tool-message',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'write',
              name: 'Write',
              input: { file_path: 'src/App.tsx', content: 'fixed' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'write', content: 'File written' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'claude-session',
        result: 'Fixed the app',
        is_error: false,
      },
    ],
  });
  const activities = [];
  const sessions = [];
  const chunks = [];
  const result = await api.send(
    request({
      provider: 'claude',
      attachments: [
        { kind: 'image', name: 'design.webp', mimeType: 'image/webp', data: 'aGVsbG8=' },
      ],
    }),
    new AbortController(),
    (chunk) => chunks.push(chunk),
    async () => true,
    (activity) => activities.push(activity),
    (id) => sessions.push(id),
  );
  const input = await api.captures.claude.prompt.next();
  assert.equal(api.captures.claude.options.systemPrompt.preset, 'claude_code');
  assert.equal(api.captures.claude.options.tools.preset, 'claude_code');
  const image = input.value.message.content.find((item) => item.type === 'image');
  assert.equal(image.source.media_type, 'image/webp');
  assert.equal(image.source.data, 'aGVsbG8=');
  assert.deepEqual(sessions, ['claude-session']);
  assert.equal(activities[0].kind, 'file');
  assert.equal(activities[1].status, 'completed');
  assert.equal(result.text, 'Fixed the app');
  assert.equal(chunks.join(''), 'Fixed the app');
  assert.equal(api.captures.closed, true);
});

test('Claude streaming does not duplicate full result text and authentication errors are actionable', async () => {
  const api = fixture({
    claudeMessages: [
      {
        type: 'stream_event',
        session_id: 'claude-session',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } },
      },
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ],
  });
  const chunks = [];
  assert.equal(
    (
      await api.send(
        request({ provider: 'claude' }),
        new AbortController(),
        (chunk) => chunks.push(chunk),
        async () => false,
      )
    ).text,
    'Done',
  );
  assert.equal(chunks.join(''), 'Done');
  const failure = fixture({
    claudeMessages: [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['OAuth session expired'],
      },
    ],
  });
  await assert.rejects(
    failure.send(
      request({ provider: 'claude' }),
      new AbortController(),
      () => {},
      async () => false,
    ),
    /claude auth login/,
  );
  assert.equal(failure.captures.closed, true);
});

test('Claude cancellation closes an SDK iterator that has stopped producing events', async () => {
  const controller = new AbortController();
  let closed = false;
  const api = fixture({
    query() {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => new Promise(() => {}),
        close() {
          closed = true;
        },
      };
    },
  });
  const sending = api.send(
    request({ provider: 'claude' }),
    controller,
    () => {},
    async () => false,
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(sending, { name: 'AbortError' });
  assert.equal(closed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('attachments reject unsupported, oversized and invalid content before provider launch', () => {
  const api = fixture();
  assert.throws(
    () =>
      api.validate(
        request({
          attachments: [
            { kind: 'image', name: 'vector.svg', mimeType: 'image/svg+xml', data: 'YWJj' },
          ],
        }),
      ),
    /PNG/,
  );
  assert.throws(
    () =>
      api.validate(
        request({
          attachments: [
            {
              kind: 'image',
              name: 'bad.png',
              mimeType: 'image/png',
              data: 'data:image/png;base64,YWJj',
            },
          ],
        }),
      ),
    /PNG/,
  );
  assert.throws(
    () =>
      api.validate(
        request({
          attachments: [{ kind: 'text', name: 'large.txt', content: 'é'.repeat(600000) }],
        }),
      ),
    /1 MB/,
  );
  assert.throws(
    () =>
      api.validate(
        request({ attachments: Array(9).fill({ kind: 'text', name: 'x', content: 'text' }) }),
      ),
    /8 files/,
  );
  assert.equal(api.children.length, 0);
});

test('successful Codex model catalogs are cached for five minutes, refreshed on demand and shared in flight', async () => {
  let now = 1000;
  let calls = 0;
  const api = fixture({
    now: () => now,
    handle(message, child) {
      baseHandle(message, child);
      if (message.method === 'model/list') {
        calls++;
        reply(child, message, {
          data: [
            {
              model: `model-${calls}`,
              displayName: 'Test model',
              supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            },
          ],
        });
      }
    },
  });
  const first = await api.models('codex');
  assert.equal(first[0].id, 'model-1');
  assert.equal((await api.models('codex'))[0].id, 'model-1');
  assert.equal(api.children.length, 1);
  const refreshed = await Promise.all([
    api.models('codex', '', undefined, true),
    api.models('codex', '', undefined, true),
  ]);
  assert.equal(refreshed[0][0].id, 'model-2');
  assert.equal(refreshed[1][0].id, 'model-2');
  assert.equal(calls, 2);
  now += 5 * 60 * 1000 + 1;
  assert.equal((await api.models('codex'))[0].id, 'model-3');
  assert.equal(api.children.length, 3);
});

test('Claude model cache avoids launching SDK discovery until refresh or expiry', async () => {
  let now = 1000;
  let launches = 0;
  let closes = 0;
  const api = fixture({
    now: () => now,
    query({ prompt }) {
      assert.equal(typeof prompt[Symbol.asyncIterator], 'function');
      launches++;
      return {
        supportedModels: async () => [
          { value: 'default', resolvedModel: 'claude-sonnet-4-6', supportsEffort: true },
        ],
        close: () => {
          closes++;
        },
      };
    },
  });
  await api.models('claude');
  await api.models('claude');
  assert.equal(launches, 1);
  await Promise.all([
    api.models('claude', '', undefined, true),
    api.models('claude', '', undefined, true),
  ]);
  assert.equal(launches, 2);
  now += 5 * 60 * 1000 + 1;
  await api.models('claude');
  assert.equal(launches, 3);
  assert.equal(closes, 3);
});

test('Codex declines stale approvals without prompting and exposes failed turns', async () => {
  const api = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method === 'turn/start') {
        reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
        child.stdout.write(
          `${JSON.stringify({ id: 99, method: 'item/fileChange/requestApproval', params: { threadId: 'another-thread', turnId: 'turn-1' } })}\n`,
        );
      }
      if (message.id === 99 && message.result) {
        assert.equal(message.result.decision, 'decline');
        completed(child, [], 'failed', { message: 'Command failed: permission denied' });
      }
    },
  });
  await assert.rejects(
    api.send(
      request(),
      new AbortController(),
      () => {},
      async () => assert.fail('Stale approval should not prompt'),
    ),
    /permission denied/,
  );
});

test('Claude without a project disables tools and never bypasses permission checks', async () => {
  const api = fixture({
    claudeMessages: [{ type: 'result', subtype: 'success', result: 'Answer', is_error: false }],
  });
  await api.send(
    request({ provider: 'claude', projectId: undefined, permission: 'full' }),
    new AbortController(),
    () => {},
    async () => assert.fail('No project tools should prompt'),
  );
  const options = api.captures.claude.options;
  assert.equal(options.tools.length, 0);
  assert.equal(options.settingSources.length, 0);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.settings.disableAllHooks, true);
  assert.equal(options.permissionMode, 'dontAsk');
  assert.equal(options.allowDangerouslySkipPermissions, false);
  assert.equal((await options.canUseTool('Bash', { command: 'touch x' })).behavior, 'deny');
});

test('both providers stop before emitting more than 2 MiB of response text', async () => {
  const tooLarge = 'x'.repeat(2 * 1024 * 1024 + 1);
  const codex = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method === 'turn/start') {
        reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
        event(child, 'item/agentMessage/delta', { itemId: 'answer', delta: tooLarge });
      }
    },
  });
  await assert.rejects(
    codex.send(
      request(),
      new AbortController(),
      () => assert.fail('Oversized chunk must not reach the UI'),
      async () => false,
    ),
    /exceeds 2 MB/,
  );
  const claude = fixture({
    claudeMessages: [{ type: 'result', subtype: 'success', result: tooLarge, is_error: false }],
  });
  await assert.rejects(
    claude.send(
      request({ provider: 'claude' }),
      new AbortController(),
      () => assert.fail('Oversized result must not reach the UI'),
      async () => false,
    ),
    /exceeds 2 MB/,
  );
  assert.equal(claude.captures.closed, true);
});

test('fresh provider sessions receive visible conversation context but resumed sessions do not replay it', async () => {
  const messages = [
    { role: 'user', content: 'Use TypeScript' },
    { role: 'assistant', content: 'Agreed' },
    { role: 'user', content: 'Fix the app' },
  ];
  const api = fixture();
  await api.send(
    request({ messages }),
    new AbortController(),
    () => {},
    async () => false,
  );
  assert.match(
    api.wire.find((item) => item.method === 'turn/start').params.input[0].text,
    /Previous conversation.*User: Use TypeScript.*Current request:/s,
  );
  const resumed = fixture();
  await resumed.send(
    request({ messages, sessionId: 'thread-1' }),
    new AbortController(),
    () => {},
    async () => false,
  );
  assert.equal(
    resumed.wire.find((item) => item.method === 'turn/start').params.input[0].text,
    'Fix the app',
  );
});

test('Codex stop requests interrupt before killing its app server', async () => {
  const controller = new AbortController();
  const api = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method === 'turn/start') {
        reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
        event(child, 'turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
        queueMicrotask(() => controller.abort());
      }
      if (message.method === 'turn/interrupt') {
        assert.equal(child.kills, 0);
        assert.equal(message.params.threadId, 'thread-1');
        assert.equal(message.params.turnId, 'turn-1');
        reply(child, message, {});
      }
    },
  });
  await assert.rejects(
    api.send(
      request(),
      controller,
      () => {},
      async () => false,
    ),
    { name: 'AbortError' },
  );
  assert.ok(api.wire.some((message) => message.method === 'turn/interrupt'));
  assert.equal(api.children[0].kills, 1);
});

test('Codex separates distinct streamed and completed assistant items without duplicating final text', async () => {
  const api = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method !== 'turn/start') return;
      reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
      event(child, 'item/agentMessage/delta', { itemId: 'progress', delta: 'I added a trailing' });
      event(child, 'item/agentMessage/delta', { itemId: 'progress', delta: ' newline.' });
      event(child, 'item/completed', {
        item: { id: 'progress', type: 'agentMessage', text: 'I added a trailing newline.' },
      });
      event(child, 'item/agentMessage/delta', { itemId: 'answer', delta: 'Done.' });
      const items = [
        { id: 'progress', type: 'agentMessage', text: 'I added a trailing newline.' },
        { id: 'answer', type: 'agentMessage', text: 'Done. Tests passed.' },
        { id: 'summary', type: 'agentMessage', text: 'Updated example.ts.' },
      ];
      for (const item of items) event(child, 'item/completed', { item });
      completed(child, items);
    },
  });
  const chunks = [];
  const result = await api.send(
    request(),
    new AbortController(),
    (chunk) => chunks.push(chunk),
    async () => false,
  );
  const expected = 'I added a trailing newline.\n\nDone. Tests passed.\n\nUpdated example.ts.';
  assert.equal(result.text, expected);
  assert.equal(chunks.join(''), expected);
});

test('Claude separates assistant messages around tools in streaming and final fallback paths', async () => {
  const messages = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'progress' } } },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'I will edit' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' the file.' } },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'File edited' }] },
    },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'answer' } } },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } },
    },
    { type: 'result', subtype: 'success', result: 'Done.', is_error: false },
  ];
  const api = fixture({ claudeMessages: messages });
  const chunks = [];
  const result = await api.send(
    request({ provider: 'claude' }),
    new AbortController(),
    (chunk) => chunks.push(chunk),
    async () => false,
  );
  assert.equal(result.text, 'I will edit the file.\n\nDone.');
  assert.equal(chunks.join(''), result.text);

  const fallback = fixture({
    claudeMessages: [
      {
        type: 'assistant',
        uuid: 'block-1',
        message: { id: 'progress', content: [{ type: 'text', text: 'I will edit' }] },
      },
      {
        type: 'assistant',
        uuid: 'block-2',
        message: { id: 'progress', content: [{ type: 'text', text: ' the file.' }] },
      },
      {
        type: 'assistant',
        uuid: 'block-3',
        message: { id: 'answer', content: [{ type: 'text', text: 'Done.' }] },
      },
      { type: 'result', subtype: 'success', result: '', is_error: false },
    ],
  });
  assert.equal(
    (
      await fallback.send(
        request({ provider: 'claude' }),
        new AbortController(),
        () => {},
        async () => false,
      )
    ).text,
    result.text,
  );
});

test('message separators count toward the response size limit', async () => {
  const api = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method !== 'turn/start') return;
      reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
      event(child, 'item/agentMessage/delta', {
        itemId: 'first',
        delta: 'x'.repeat(2 * 1024 * 1024 - 2),
      });
      event(child, 'item/agentMessage/delta', { itemId: 'second', delta: 'y' });
    },
  });
  let bytes = 0;
  await assert.rejects(
    api.send(
      request(),
      new AbortController(),
      (chunk) => {
        bytes += Buffer.byteLength(chunk);
      },
      async () => false,
    ),
    /exceeds 2 MB/,
  );
  assert.equal(bytes, 2 * 1024 * 1024 - 2);
});

test('file activities carry line diffs for Claude edits and Codex file changes', async () => {
  const claude = fixture({
    claudeMessages: [
      {
        type: 'assistant',
        uuid: 'edits',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'edit',
              name: 'Edit',
              input: {
                file_path: 'D:\project\a.ts',
                old_string: 'one\ntwo\nthree',
                new_string: 'one\n2\nthree',
              },
            },
            {
              type: 'tool_use',
              id: 'write',
              name: 'Write',
              input: { file_path: 'D:\project\b.ts', content: 'x\ny\n' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'ok' }] },
        tool_use_result: {
          structuredPatch: [
            {
              oldStart: 4,
              oldLines: 3,
              newStart: 4,
              newLines: 3,
              lines: [' one', '-two', '+2', ' three'],
            },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'write', content: 'ok' }] },
        tool_use_result: { type: 'create', structuredPatch: [] },
      },
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ],
  });
  const activities = new Map();
  await claude.send(
    request({ provider: 'claude' }),
    new AbortController(),
    () => {},
    async () => true,
    (a) => activities.set(a.id, JSON.parse(JSON.stringify(a))),
  );
  assert.deepEqual(activities.get('edit').changes, [
    {
      path: 'D:\project\a.ts',
      kind: 'update',
      additions: 1,
      deletions: 1,
      diff: '@@ -4,3 +4,3 @@\n one\n-two\n+2\n three',
    },
  ]);
  assert.deepEqual(activities.get('write').changes, [
    { path: 'D:\project\b.ts', kind: 'add', additions: 2, deletions: 0, diff: '+x\n+y' },
  ]);

  const codex = fixture({
    handle(message, child) {
      baseHandle(message, child);
      if (message.method !== 'turn/start') return;
      reply(child, message, { turn: { id: 'turn-1', status: 'inProgress' } });
      event(child, 'item/completed', {
        item: {
          id: 'files',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'new.ts', kind: { type: 'add' }, diff: 'hello\n' },
            {
              path: 'old.ts',
              kind: { type: 'update' },
              diff: '--- a/old.ts\n+++ b/old.ts\n@@ -1 +1 @@\n-a\n+b\n',
            },
          ],
        },
      });
      const item = { id: 'answer', type: 'agentMessage', text: 'Done' };
      event(child, 'item/completed', { item });
      completed(child, [item]);
    },
  });
  const codexActivities = [];
  await codex.send(
    request(),
    new AbortController(),
    () => {},
    async () => true,
    (a) => codexActivities.push(a),
  );
  const changes = JSON.parse(JSON.stringify(codexActivities.find((a) => a.id === 'files').changes));
  assert.deepEqual(changes, [
    { path: 'new.ts', kind: 'add', additions: 1, deletions: 0, diff: '+hello' },
    { path: 'old.ts', kind: 'update', additions: 1, deletions: 1, diff: '@@ -1 +1 @@\n-a\n+b' },
  ]);
});
