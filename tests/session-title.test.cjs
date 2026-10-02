const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isAgentContextReset,
  summarizeAgentPrompt,
  summarizeShellCommands,
} = require('../src/sessionTitle.ts');

test('agent prompts drop filler and keep their first sentence', () => {
  assert.equal(
    summarizeAgentPrompt(
      'can you review how the dashboard pops in and out. I want the terminals to move smoothly',
    ),
    'Review how the dashboard pops in and out',
  );
  assert.equal(
    summarizeAgentPrompt('can you improve the way the terminals summarise a task. Ensure it works'),
    'Improve the way the terminals summarise a task',
  );
  assert.equal(summarizeAgentPrompt('Hey, so could you please add dark mode'), 'Add dark mode');
  assert.equal(summarizeAgentPrompt('fix the login bug please'), 'Fix the login bug');
});

test('agent prompts are not read as shell commands', () => {
  assert.equal(summarizeAgentPrompt('git is broken, fix it'), 'Git is broken, fix it');
  assert.equal(
    summarizeAgentPrompt('find where the auth token is stored'),
    'Find where the auth token is stored',
  );
  assert.equal(
    summarizeAgentPrompt('npm install fails with ERESOLVE; fix it'),
    'Npm install fails with ERESOLVE; fix it',
  );
});

test('long agent prompts end at a clause rather than mid-word', () => {
  assert.equal(
    summarizeAgentPrompt(
      'refactor the settings page so every option saves immediately without a button',
    ),
    'Refactor the settings page',
  );
  const title = summarizeAgentPrompt(
    'investigate the intermittent websocket disconnection in production dashboards',
  );
  assert.ok(title.length <= 48 && title.endsWith('…'), title);
});

test('file mentions become file names, and emails are left alone', () => {
  assert.equal(summarizeAgentPrompt('@src/App.tsx tidy up the imports'), 'App.tsx tidy up the imports');
  assert.equal(summarizeAgentPrompt('email a@b.com the report'), 'Email a@b.com the report');
});

test('replies and CLI commands are not tasks', () => {
  for (const reply of ['1', 'y', 'yes', 'Yes please', 'continue', 'ok!', 'thanks', '/model', '/clear']) {
    assert.equal(summarizeAgentPrompt(reply), undefined, reply);
  }
  assert.equal(isAgentContextReset('/clear'), true);
  assert.equal(isAgentContextReset('/new'), true);
  assert.equal(isAgentContextReset('/model'), false);
});

test('a shell is titled by its latest meaningful command', () => {
  assert.equal(
    summarizeShellCommands(['npm install', 'npm run dev', 'ls', 'cd src']),
    'Run the development server',
  );
  assert.equal(summarizeShellCommands(['cd app && npm test']), 'Run project tests');
  assert.equal(summarizeShellCommands(['make deploy']), 'Run make deploy');
  assert.equal(summarizeShellCommands(['./scripts/deploy.sh']), 'Run deploy.sh');
  assert.equal(summarizeShellCommands(['cls', 'ls -la']), undefined);
});
