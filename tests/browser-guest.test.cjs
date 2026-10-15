const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserShortcut, contextMenuTemplate } = require('../electron/browser-guest.cjs');

const key = (k, mods = {}) => ({ type: 'keyDown', key: k, control: false, meta: false, shift: false, alt: false, ...mods });

test('Chrome shortcuts inside a page become browser commands', () => {
  assert.equal(browserShortcut(key('t', { control: true })), 'new-tab');
  assert.equal(browserShortcut(key('W', { control: true })), 'close-tab');
  assert.equal(browserShortcut(key('l', { control: true })), 'focus-address');
  assert.equal(browserShortcut(key('d', { alt: true })), 'focus-address');
  assert.equal(browserShortcut(key('F6')), 'focus-address');
  assert.equal(browserShortcut(key('f', { meta: true })), 'find');
  assert.equal(browserShortcut(key('h', { control: true })), 'history');
  assert.equal(browserShortcut(key('F5')), 'reload');
  assert.equal(browserShortcut(key('r', { control: true })), 'reload');
  assert.equal(browserShortcut(key('R', { control: true, shift: true })), 'hard-reload');
  assert.equal(browserShortcut(key('F5', { control: true })), 'hard-reload');
  assert.equal(browserShortcut(key('F5', { shift: true })), 'hard-reload');
  assert.equal(browserShortcut(key('ArrowLeft', { alt: true })), 'back');
  assert.equal(browserShortcut(key('ArrowRight', { alt: true })), 'forward');
  assert.equal(browserShortcut(key('Tab', { control: true })), 'next-tab');
  assert.equal(browserShortcut(key('Tab', { control: true, shift: true })), 'previous-tab');
  assert.equal(browserShortcut(key('PageUp', { control: true })), 'previous-tab');
  assert.equal(browserShortcut(key('F12')), 'devtools');
  assert.equal(browserShortcut(key('I', { control: true, shift: true })), 'devtools');
});

test('other keys stay with the page', () => {
  for (const input of [
    key('t'),
    key('f'),
    key('c', { control: true }),
    key('v', { control: true }),
    key('a', { control: true }),
    key('t', { control: true, shift: true }),
    key('f', { control: true, alt: true }),
    key('ArrowLeft'),
    key('ArrowLeft', { control: true }),
    key('Escape'),
    { ...key('t', { control: true }), type: 'keyUp' },
    undefined,
  ])
    assert.equal(browserShortcut(input), null, JSON.stringify(input));
});

const calls = [];
const actions = new Proxy({ canOpen: (url) => url.startsWith('https:'), canGoBack: () => true, canGoForward: () => false }, {
  get: (target, name) => target[name] ?? ((...args) => calls.push([name, ...args])),
});
const labels = (template) => template.map((item) => (item.type === 'separator' ? '-' : item.label));

test('a plain page offers navigation, print and inspect', () => {
  const template = contextMenuTemplate({ editFlags: {} }, actions);
  assert.deepEqual(labels(template), ['Back', 'Forward', 'Reload', '-', 'Print…', '-', 'Inspect']);
  assert.equal(template[0].enabled, true);
  assert.equal(template[1].enabled, false);
});

test('links, images and selections get their own items', () => {
  calls.length = 0;
  const template = contextMenuTemplate({
    linkURL: 'https://example.com/a',
    mediaType: 'image',
    srcURL: 'https://example.com/i.png',
    selectionText: '  the   quick brown fox jumps over the lazy dog  ',
    editFlags: {},
  }, actions);
  assert.deepEqual(labels(template), [
    'Open link in new tab', 'Copy link address', '-',
    'Open image in new tab', 'Copy image', 'Copy image address', '-',
    'Copy', '-',
    'Search Google for “the quick brown fox jumps over…”', '-',
    'Inspect',
  ]);
  template[0].click();
  template[1].click();
  template.find((item) => item.label?.startsWith('Search')).click();
  assert.deepEqual(calls, [
    ['openTab', 'https://example.com/a'],
    ['copyText', 'https://example.com/a'],
    ['search', 'the   quick brown fox jumps over the lazy dog'],
  ]);
});

test('links the browser cannot open are not offered as tabs', () => {
  const template = contextMenuTemplate({ linkURL: 'javascript:alert(1)', editFlags: {} }, actions);
  assert.equal(labels(template).includes('Open link in new tab'), false);
});

test('text fields offer editing and spelling suggestions', () => {
  calls.length = 0;
  const template = contextMenuTemplate({
    isEditable: true,
    misspelledWord: 'helo',
    dictionarySuggestions: ['hello', 'help'],
    editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
  }, actions);
  assert.deepEqual(labels(template), [
    'hello', 'help', 'Add to dictionary', '-', 'Undo', 'Redo', '-', 'Cut', 'Copy', 'Paste', 'Select all', '-', 'Inspect',
  ]);
  assert.deepEqual(template.filter((item) => item.role).map((item) => item.enabled), [false, false, false, false, true, true]);
  template[0].click();
  template[2].click();
  assert.deepEqual(calls, [['replaceMisspelling', 'hello'], ['addToDictionary', 'helo']]);
});
