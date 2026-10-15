/** Stable model identities keep undo history separate across projects and files. */
export const editorPath = (projectId: string, path: string) =>
  `veyo://${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`;

export function parentFolders(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

export function tabLabel(path: string, paths: readonly string[]): string {
  const parts = path.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const label = parts.slice(-depth).join('/');
    if (
      !paths.some((other) => other !== path && other.split('/').slice(-depth).join('/') === label)
    )
      return label;
  }
  return path;
}

// Monaco normalizes line endings and hides the UTF-8 BOM from the text buffer.
// A BOM is file metadata, so retain it when editing a file that already has one.
export function editorContent(value: string, saved: string): string {
  return saved.startsWith('\uFEFF') && !value.startsWith('\uFEFF') ? `\uFEFF${value}` : value;
}
