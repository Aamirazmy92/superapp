const { test } = require('node:test');
const assert = require('node:assert/strict');
const { acceptLanguages, chromeUserAgent } = require('../electron/browser-locale.cjs');

test('languages are listed the way Chrome lists them', () => {
  assert.equal(acceptLanguages(['en-GB', 'en-US']), 'en-GB,en-US,en');
  assert.equal(acceptLanguages(['en-GB']), 'en-GB,en');
  assert.equal(acceptLanguages(['fr-FR', 'en-GB']), 'fr-FR,fr,en-GB,en');
  assert.equal(acceptLanguages(['de', 'de-AT']), 'de,de-AT');
});

test('languages skip invalid or repeated tags and have a default', () => {
  assert.equal(acceptLanguages(['en-GB', 'EN-gb', 'bad tag', 42, 'x\r\nInjected: 1']), 'en-GB,en');
  assert.equal(acceptLanguages([]), 'en-US,en');
  assert.equal(acceptLanguages(['de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'sv', 'da', 'fi', 'no']).split(',').length, 8);
});

test('user agent is Chrome without Electron or app tokens', () => {
  const ua = chromeUserAgent('win32', '152.0.7977.130');
  assert.equal(ua, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36');
  assert.match(chromeUserAgent('darwin', '152.1'), /Macintosh; Intel Mac OS X 10_15_7.*Chrome\/152\.0\.0\.0/);
  assert.match(chromeUserAgent('linux', '152'), /X11; Linux x86_64/);
  assert.doesNotMatch(ua, /Electron|Veyo/i);
});
