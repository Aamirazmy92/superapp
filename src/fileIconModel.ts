export type FileIconTables = {
  file: string;
  names: Record<string, string>;
  extensions: Record<string, string>;
  light: { names: Record<string, string>; extensions: Record<string, string> };
};

/**
 * The icon for a file name, resolved like VS Code's Material Icon Theme: an
 * exact file name first, then the longest matching extension ("app.test.ts"
 * tries "test.ts" before "ts"), then the generic file icon. The light theme
 * uses its own variants where the set has them.
 */
export function fileIconName(name: string, tables: FileIconTables, light = false): string {
  const lower = name.toLowerCase();
  if (light && tables.light.names[lower]) return tables.light.names[lower];
  if (tables.names[lower]) return tables.names[lower];
  const parts = lower.split('.');
  // "a.b.ts" -> "b.ts", "ts"; a dotfile like ".env" -> "env".
  for (let start = 1; start < parts.length; start++) {
    const extension = parts.slice(start).join('.');
    if (!extension) continue;
    if (light && tables.light.extensions[extension]) return tables.light.extensions[extension];
    if (tables.extensions[extension]) return tables.extensions[extension];
  }
  return tables.file;
}
