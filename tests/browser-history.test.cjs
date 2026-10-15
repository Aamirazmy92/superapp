const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserHistory } = require('../electron/browser-history.cjs');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function setup(saved, start = 100 * DAY) {
  const clock = { time: start };
  const writes = [];
  let changes = 0;
  const history = createBrowserHistory({
    load: async () => {
      if (saved === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return saved;
    },
    save: async (entries) => { writes.push(entries); },
    onChange: () => { changes += 1; },
    now: () => clock.time,
    saveDelay: 0,
  });
  return { history, clock, writes, changes: () => changes };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('visits are listed newest first with their titles', async () => {
  const { history, clock, writes } = setup();
  await history.record('http://localhost:3000/', 'Home');
  clock.time += 1000;
  await history.record('https://example.com/docs', '');
  await history.retitle('https://example.com/docs', '  Docs  ');
  const entries = await history.list();
  assert.deepEqual(entries.map(({ url, title }) => ({ url, title })), [
    { url: 'https://example.com/docs', title: 'Docs' },
    { url: 'http://localhost:3000/', title: 'Home' },
  ]);
  await settle();
  assert.equal(writes.at(-1).length, 2, 'visits are saved');
});

test('revisiting the current page updates it instead of adding a duplicate', async () => {
  const { history, clock } = setup();
  await history.record('https://example.com/', 'Example');
  clock.time += 5000;
  await history.record('https://example.com/', '');
  const [entry, ...rest] = await history.list();
  assert.equal(rest.length, 0);
  assert.equal(entry.visitedAt, clock.time);
  assert.equal(entry.title, 'Example', 'an empty title keeps the known one');
  await history.record('https://example.com/other', 'Other');
  await history.record('https://example.com/', 'Example');
  assert.equal((await history.list()).length, 3, 'going back to an earlier page is a new visit');
});

test('only web pages are recorded', async () => {
  const { history } = setup();
  for (const url of ['about:blank', 'file:///C:/secret.txt', 'chrome://gpu', 'https://user:pass@example.com/', 'not a url', 42])
    await history.record(url, 'Nope');
  assert.deepEqual(await history.list(), []);
});

test('search matches every word against titles and addresses', async () => {
  const { history, clock } = setup();
  await history.record('https://react.dev/learn', 'Quick Start – React');
  clock.time += 1;
  await history.record('https://vitejs.dev/guide', 'Getting Started | Vite');
  clock.time += 1;
  await history.record('http://localhost:5173/', 'My app');
  assert.deepEqual((await history.list('react')).map((entry) => entry.url), ['https://react.dev/learn']);
  assert.deepEqual((await history.list('START vite')).map((entry) => entry.url), ['https://vitejs.dev/guide']);
  assert.deepEqual((await history.list('localhost')).map((entry) => entry.title), ['My app']);
  assert.deepEqual(await history.list('nothing-matches'), []);
});

test('single entries can be removed and are saved right away', async () => {
  const { history, clock, writes, changes } = setup();
  await history.record('https://a.example/', 'A');
  clock.time += 1;
  await history.record('https://b.example/', 'B');
  const [b] = await history.list();
  const before = changes();
  await history.remove([b.id]);
  assert.deepEqual((await history.list()).map((entry) => entry.title), ['A']);
  assert.deepEqual(writes.at(-1).map((entry) => entry.title), ['A']);
  assert.equal(changes(), before + 1);
  await history.remove(['unknown-id']);
  assert.equal(changes(), before + 1, 'removing nothing is not a change');
});

test('clearing a time range keeps older visits', async () => {
  const { history, clock, writes } = setup();
  await history.record('https://old.example/', 'Old');
  clock.time += 2 * DAY;
  await history.record('https://yesterday.example/', 'Yesterday');
  clock.time += 20 * HOUR;
  await history.record('https://recent.example/', 'Recent');
  clock.time += 10 * 60 * 1000;
  await history.clear('hour');
  assert.deepEqual((await history.list()).map((entry) => entry.title), ['Yesterday', 'Old']);
  // Yesterday's visit is now 23h10m old; Old is more than two days old.
  clock.time += 3 * HOUR;
  await history.clear('day');
  assert.deepEqual((await history.list()).map((entry) => entry.title), ['Old']);
  await history.clear('all');
  assert.deepEqual(await history.list(), []);
  assert.deepEqual(writes.at(-1), []);
  await assert.rejects(history.clear('forever'), /time range/);
});

test('saved history is validated and old visits expire', async () => {
  const now = 200 * DAY;
  const { history } = setup([
    { id: '1', url: 'https://kept.example/', title: 'Kept', visitedAt: now - DAY },
    { id: '2', url: 'https://expired.example/', title: 'Expired', visitedAt: now - 91 * DAY },
    { id: '3', url: 'javascript:alert(1)', title: 'Bad', visitedAt: now },
    { id: 4, url: 'https://bad-id.example/', visitedAt: now },
    null,
    { id: '5', url: 'https://newer.example/', title: 7, visitedAt: now - HOUR },
  ], now);
  assert.deepEqual((await history.list()).map(({ id, title }) => ({ id, title })), [
    { id: '5', title: '' },
    { id: '1', title: 'Kept' },
  ]);
});

test('a missing or unreadable file starts an empty history', async () => {
  assert.deepEqual(await setup(undefined).history.list(), []);
  assert.deepEqual(await setup({ not: 'a list' }).history.list(), []);
});
