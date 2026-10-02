import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const expected = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).build
  .electronVersion;
const installed = require('electron/package.json').version;
if (installed !== expected) {
  throw new Error(
    `Installed Electron ${installed} does not match release version ${expected}. Close running development sessions and run npm ci before packaging.`,
  );
}

const electronRoot = path.dirname(require.resolve('electron/package.json'));
const distribution = path.join(electronRoot, 'dist');
const required = [
  'electron.exe',
  'icudtl.dat',
  'resources.pak',
  'snapshot_blob.bin',
  path.join('resources', 'default_app.asar'),
];
try {
  const version = (await readFile(path.join(distribution, 'version'), 'utf8')).trim();
  if (version !== expected) throw new Error(`Runtime version is ${version}.`);
  for (const name of required) {
    if (!(await stat(path.join(distribution, name))).isFile())
      throw new Error(`${name} is missing.`);
  }
} catch (error) {
  throw new Error(
    `The Electron ${expected} installation is incomplete (${error.message}). Close running development sessions and run npm ci before packaging.`,
  );
}
