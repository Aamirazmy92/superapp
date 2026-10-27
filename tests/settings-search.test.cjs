const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchesSearch } = require('../src/settingsSearch.ts');

const wordWrap = ['Word wrap', 'Wrap long lines to fit the editor width.', 'overflow editor'];

test('an empty query matches everything', () => {
  assert.equal(matchesSearch('', 'anything'), true);
  assert.equal(matchesSearch('   ', 'anything'), true);
});

test('words may appear in any order and across fields', () => {
  assert.equal(matchesSearch('wrap word', ...wordWrap), true);
  assert.equal(matchesSearch('editor wrap', ...wordWrap), true);
  assert.equal(matchesSearch('wrap terminal', ...wordWrap), false);
});

test('prefixes, joined words and case are forgiven', () => {
  assert.equal(matchesSearch('WORDW', ...wordWrap), true);
  assert.equal(matchesSearch('wordwrap', ...wordWrap), true);
  assert.equal(matchesSearch('wor', ...wordWrap), true);
});

test('a single typo in a longer word still matches', () => {
  assert.equal(matchesSearch('terminl', 'Terminal font', 'Font for shell output.'), true);
  assert.equal(matchesSearch('scrolback', 'Scrollback', 'Maximum lines'), true);
  assert.equal(matchesSearch('wrp', ...wordWrap), false);
});

test('unrelated settings do not match', () => {
  assert.equal(matchesSearch('minimap', 'Tab size', 'Number of spaces displayed for a tab.', 'indent'), false);
  assert.equal(matchesSearch('dark', 'Reduce motion', 'Open and close panels instantly.'), false);
});

test('keywords find settings by another name', () => {
  assert.equal(matchesSearch('dark', 'Color theme', 'Applies to the workspace.', 'dark light appearance'), true);
});

test('shortcut keys are searchable', () => {
  assert.equal(matchesSearch('ctrl s', 'Save current file', 'Ctrl + S'), true);
  assert.equal(matchesSearch('ctrl k', 'Save current file', 'Ctrl + S'), false);
});

test('a partial word matches only words that start with it', () => {
  assert.equal(matchesSearch('redu', 'Reduce motion', 'Open and close panels instantly.'), true);
  assert.equal(matchesSearch('redu', 'Stored on your device', 'Returning to work, terminals and presets.'), false);
  assert.equal(matchesSearch('ode', 'Color mode', 'Choose a mode.'), false);
  assert.equal(matchesSearch('r', 'Reduce motion', 'Open panels.'), true);
  assert.equal(matchesSearch('r', 'Tab size', 'Number of spaces displayed for a tab.'), false);
});
