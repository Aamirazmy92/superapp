// Builds src/fileIcons.generated.json from the Material Icon Theme manifest
// (MIT, https://github.com/material-extensions/vscode-material-icon-theme).
// Only the file-name and extension tables are kept; the SVGs themselves are
// bundled from node_modules by src/fileIcons.ts.
// Run after updating the package: node scripts/gen-file-icons.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('material-icon-theme/dist/material-icons.json');
const { version } = JSON.parse(
  await readFile(require.resolve('material-icon-theme/package.json'), 'utf8'),
);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

// Icon ids map to ./../icons/<file>.svg; keep only the file stem.
const stem = (id) => {
  const definition = manifest.iconDefinitions[id];
  return definition ? definition.iconPath.replace(/^.*\//, '').replace(/\.svg$/, '') : null;
};
const table = (entries = {}) =>
  Object.fromEntries(
    Object.entries(entries)
      .map(([key, id]) => [key.toLowerCase(), stem(id)])
      .filter(([, value]) => value)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

const output = {
  source: `material-icon-theme@${version}`,
  file: stem(manifest.file),
  names: table(manifest.fileNames),
  extensions: table(manifest.fileExtensions),
  light: {
    names: table(manifest.light?.fileNames),
    extensions: table(manifest.light?.fileExtensions),
  },
};
await writeFile(new URL('../src/fileIcons.generated.json', import.meta.url), `${JSON.stringify(output)}\n`);
console.log(
  `Wrote ${Object.keys(output.names).length} file names and ${Object.keys(output.extensions).length} extensions from ${output.source}.`,
);
