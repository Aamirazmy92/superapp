const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AGENT_INPUT_ECHO_MS,
  AGENT_RESPONSE_SETTLE_MS,
  recordAgentKeystroke,
  recordAgentOutput,
  settleAgentTurn,
} = require('../src/agentTurn.ts');

const SETTLE = AGENT_RESPONSE_SETTLE_MS;

test('a reply stays working through a short pause and settles after sustained silence', () => {
  const turn = { submittedAt: 100, lastOutputAt: 0 };
  assert.equal(recordAgentOutput(turn, 120), false);
  assert.equal(settleAgentTurn(turn, 120 + SETTLE - 1), false);
  assert.equal(turn.completedAt, undefined);
  assert.equal(settleAgentTurn(turn, 120 + SETTLE), true);
  assert.equal(turn.completedAt, 120 + SETTLE);
});

test('redraw output after a reply finishes does not move it back to working', () => {
  const turn = { submittedAt: 100, lastOutputAt: 120 };
  assert.equal(settleAgentTurn(turn, 120 + SETTLE), true);
  // Resizing or focusing the pane makes the agent repaint its screen.
  assert.equal(recordAgentOutput(turn, 120 + SETTLE + 10), false);
  assert.equal(recordAgentOutput(turn, 120 + SETTLE * 3), false);
  assert.equal(turn.completedAt, 120 + SETTLE);
});

test('answering a finished agent reopens it once its output outlasts the echo', () => {
  const turn = { submittedAt: 100, lastOutputAt: 120 };
  const done = 120 + SETTLE;
  assert.equal(settleAgentTurn(turn, done), true);
  const key = done + 1000;
  recordAgentKeystroke(turn, key);
  assert.equal(recordAgentOutput(turn, key + 20), false);
  assert.notEqual(turn.completedAt, undefined);
  const resumed = key + AGENT_INPUT_ECHO_MS;
  assert.equal(recordAgentOutput(turn, resumed), true);
  assert.equal(turn.completedAt, undefined);
  assert.equal(settleAgentTurn(turn, resumed + SETTLE - 1), false);
  assert.equal(settleAgentTurn(turn, resumed + SETTLE), true);
});

test('keystrokes while a reply is still working do not change it', () => {
  const turn = { submittedAt: 100, lastOutputAt: 120 };
  recordAgentKeystroke(turn, 130);
  assert.equal(turn.touchedAt, undefined);
  assert.equal(recordAgentOutput(turn, 140), false);
  assert.equal(turn.lastOutputAt, 140);
});

test('launch output before the prompt does not count as reply output', () => {
  const turn = { submittedAt: 100, lastOutputAt: 0 };
  assert.equal(recordAgentOutput(turn, 90), false);
  assert.equal(turn.lastOutputAt, 0);
});

test('a prompt the agent never answers still settles instead of staying working', () => {
  const turn = { submittedAt: 100, lastOutputAt: 0 };
  assert.equal(settleAgentTurn(turn, 100 + SETTLE - 1), false);
  assert.equal(settleAgentTurn(turn, 100 + SETTLE), true);
});
