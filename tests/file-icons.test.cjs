const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fileIconName } = require('../src/fileIconModel.ts');

const tables = require('../src/fileIcons.generated.json');
const icons = new Set(
  fs
    .readdirSync(path.join(__dirname, '..', 'node_modules', 'material-icon-theme', 'icons'))
    .map((name) => name.replace(/\.svg$/, '')),
);
const icon = (name, light) => fileIconName(name, tables, light);

test('Common languages get their own icons', () => {
  const expected = {
    'app.ts': 'typescript',
    'App.tsx': 'react_ts',
    'main.py': 'python',
    'lib.rs': 'rust',
    'server.go': 'go',
    'Program.cs': 'csharp',
    'index.html': 'html',
    'styles.css': 'css',
    'README.md': 'readme',
    'notes.md': 'markdown',
    'data.json': 'json',
    'config.yml': 'yaml',
    'run.ps1': 'powershell',
    'build.sh': 'console',
  };
  for (const [name, id] of Object.entries(expected)) assert.equal(icon(name), id, name);
});

test('Exact file names win over extensions', () => {
  assert.equal(icon('.gitignore'), 'git');
  assert.equal(icon('package.json'), 'nodejs');
  assert.equal(icon('tsconfig.json'), 'tsconfig');
  assert.equal(icon('vite.config.ts'), 'vite');
  assert.equal(icon('.prettierrc.json'), 'prettier');
  assert.equal(icon('Dockerfile'), 'docker', 'names match without case');
});

test('The longest extension wins, and dotfiles use their extension', () => {
  assert.equal(icon('app.test.ts'), 'test-ts');
  assert.equal(icon('types.d.ts'), 'typescript-def');
  assert.equal(icon('.env'), 'tune');
});

test('Unknown files fall back to the generic icon', () => {
  assert.equal(icon('mystery.zzqq'), tables.file);
  assert.equal(icon('Makefile.unknownthing'), tables.file);
});

test('Light theme uses its variants where the set has them', () => {
  const [name, lightIcon] = Object.entries(tables.light.names)[0];
  assert.equal(icon(name, true), lightIcon);
  assert.equal(icon('app.ts', true), icon('app.ts'), 'no light variant keeps the normal icon');
});

test('Every icon the tables name exists in the package', () => {
  const all = [
    tables.file,
    ...Object.values(tables.names),
    ...Object.values(tables.extensions),
    ...Object.values(tables.light.names),
    ...Object.values(tables.light.extensions),
  ];
  const missing = [...new Set(all)].filter((id) => !icons.has(id));
  assert.deepEqual(missing, []);
});
