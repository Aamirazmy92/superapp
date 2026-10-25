import tables from './fileIcons.generated.json';
import { fileIconName, type FileIconTables } from './fileIconModel';

// Material Icon Theme (MIT). Each SVG is its own asset, fetched only when a
// file of that kind is shown; none are inlined into the script bundle.
const urls = import.meta.glob<string>('../node_modules/material-icon-theme/icons/*.svg', {
  query: '?no-inline',
  import: 'default',
  eager: true,
});
const byName = new Map(
  Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -4), url]),
);

export function fileIconUrl(name: string): string | undefined {
  const light = document.documentElement.dataset.theme === 'light';
  const icon = fileIconName(name, tables as FileIconTables, light);
  return byName.get(icon) ?? byName.get((tables as FileIconTables).file);
}
