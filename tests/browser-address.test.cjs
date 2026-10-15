const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserTarget, searchURL } = require('../src/browserAddress.ts');

test('words and phrases search Google', () => {
  assert.deepEqual(browserTarget('react hooks tutorial'), {
    url: 'https://www.google.com/search?q=react+hooks+tutorial&sourceid=chrome&ie=UTF-8',
  });
  assert.deepEqual(browserTarget('weather'), { url: searchURL('weather') });
  assert.deepEqual(browserTarget('what is 5 + 5?'), { url: searchURL('what is 5 + 5?') });
  assert.deepEqual(browserTarget('?github.com'), { url: searchURL('github.com') });
});

test('searches are sent as Chrome sends them, with no forced region', () => {
  assert.equal(searchURL('weather'), 'https://www.google.com/search?q=weather&sourceid=chrome&ie=UTF-8');
  assert.equal(new URL(searchURL('c++ & c# vs. 100%')).searchParams.get('q'), 'c++ & c# vs. 100%');
  assert.equal(new URL(searchURL('weather')).searchParams.has('gl'), false);
});

test('numbers are searched rather than opened as addresses', () => {
  assert.deepEqual(browserTarget('3.14'), { url: searchURL('3.14') });
  assert.deepEqual(browserTarget('1.5.2'), { url: searchURL('1.5.2') });
});

test('host names open directly, falling back to a search', () => {
  assert.deepEqual(browserTarget('github.com'), { url: 'https://github.com/', fallback: searchURL('github.com') });
  assert.deepEqual(browserTarget('react.dev/learn?x=1'), {
    url: 'https://react.dev/learn?x=1',
    fallback: searchURL('react.dev/learn?x=1'),
  });
  assert.equal(browserTarget('node.js').fallback, searchURL('node.js'));
});

test('full and local addresses open without a fallback', () => {
  assert.deepEqual(browserTarget('https://example.com/a b'), { url: 'https://example.com/a%20b' });
  assert.deepEqual(browserTarget('localhost:3000'), { url: 'http://localhost:3000/' });
  assert.deepEqual(browserTarget(' http://127.0.0.1:5173/app '), { url: 'http://127.0.0.1:5173/app' });
});

test('unsafe or empty addresses are rejected', () => {
  assert.throws(() => browserTarget('http://example.com'), /HTTPS/);
  assert.throws(() => browserTarget('file:///C:/secret.txt'), /HTTPS/);
  assert.throws(() => browserTarget('https://user:pass@example.com'), /HTTPS/);
  assert.throws(() => browserTarget('   '), /Enter an address/);
});
