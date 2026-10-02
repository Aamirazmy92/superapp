const { test } = require('node:test');
const assert = require('node:assert/strict');
const { editorPath, parentFolders, tabLabel, editorContent } = require('../src/editorModel.ts');
const { language } = require('../src/workspaceModel.ts');

test('model identities separate projects and escape URI control characters', () => {
  assert.notEqual(editorPath('one', 'src/file.ts'), editorPath('two', 'src/file.ts'));
  assert.equal(editorPath('one', 'a #b/what?.ts'), 'superapp://one/a%20%23b/what%3F.ts');
  assert.notEqual(editorPath('one', 'what?.ts'), editorPath('one', 'what%3F.ts'));
});
test('tabs use the shortest unambiguous path', () => {
  const paths = ['src/index.ts', 'tests/index.ts', 'src/deep/index.ts', 'README.md'];
  assert.equal(tabLabel('src/index.ts', paths), 'src/index.ts');
  assert.equal(tabLabel('src/deep/index.ts', paths), 'deep/index.ts');
  assert.equal(tabLabel('README.md', paths), 'README.md');
  assert.deepEqual(parentFolders('src/deep/index.ts'), ['src', 'src/deep']);
  assert.deepEqual(parentFolders('README.md'), []);
});
test('edits preserve the original BOM without adding or duplicating it', () => {
  assert.equal(editorContent('edited', '\uFEFForiginal'), '\uFEFFedited');
  assert.equal(editorContent('\uFEFFedited', '\uFEFForiginal'), '\uFEFFedited');
  assert.equal(editorContent('edited', 'original'), 'edited');
});
test('language detection supports common source files and case insensitive extensions', () => {
  assert.equal(language('src/APP.TSX'), 'typescript');
  assert.equal(language('script.mjs'), 'javascript');
  assert.equal(language('main.go'), 'go');
  assert.equal(language('Dockerfile.dev'), 'dockerfile');
  assert.equal(language('unknown.custom'), 'plaintext');
});
