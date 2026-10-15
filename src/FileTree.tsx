import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, FileCode2, FileJson, FileText, MoreHorizontal } from './icons';
import type { Entry } from './types';
import { parentFolders } from './editorModel';
export function FileIcon({ name }: { name: string }) {
  if (/\.(json|jsonc)$/i.test(name)) return <FileJson size={14} className="file-json" />;
  if (
    /\.(tsx?|jsx?|mts|cts|mjs|cjs|s?css|html?|py|rs|go|c|cpp|h|java|cs|vue|svelte|sh|ps1|sql|ya?ml)$/i.test(
      name,
    )
  )
    return <FileCode2 size={14} className="file-code" />;
  return <FileText size={14} className="file-other" />;
}
export default function FileTree({
  projectId,
  active,
  onOpen,
  refresh,
  onManage,
  dirtyPaths = [],
  showIgnored = false,
  collapse = 0,
}: {
  projectId: string;
  active?: string;
  onOpen(path: string): void;
  refresh: number;
  onError(error: unknown): void;
  onManage?(entry: Entry, anchor?: HTMLElement): void;
  dirtyPaths?: string[];
  showIgnored?: boolean;
  collapse?: number;
}) {
  const [entries, setEntries] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(['', ...parentFolders(active || '')]),
  );
  const [loading, setLoading] = useState(true);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState(active || '');
  const tree = useRef<HTMLDivElement>(null);
  const cache = useRef<{ key: string; entries: Record<string, Entry[]> }>({ key: '', entries: {} });
  const typeahead = useRef({ text: '', at: 0 });
  const previousCollapse = useRef(collapse);
  useEffect(() => {
    if (!active) return;
    setExpanded((previous) => new Set([...previous, ...parentFolders(active)]));
    setFocused(active);
  }, [active]);
  useEffect(() => {
    if (previousCollapse.current === collapse) return;
    previousCollapse.current = collapse;
    setExpanded(new Set(['']));
  }, [collapse]);
  useEffect(() => {
    let canceled = false;
    const key = `${projectId}:${refresh}:${showIgnored}`;
    const previous = cache.current.key === key ? cache.current.entries : {};
    const dirs = [...expanded].filter((dir) => !previous[dir]);
    if (!dirs.length) {
      setEntries(previous);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailures({});
    Promise.all(
      dirs.map(async (dir) => {
        try {
          return { dir, entries: await window.workspace!.listFiles(projectId, dir, showIgnored) };
        } catch (error) {
          return { dir, error: String(error).replace(/^Error:.*?Error: /, '') };
        }
      }),
    ).then((results) => {
      if (canceled) return;
      const next = { ...previous };
      const errors: Record<string, string> = {};
      for (const result of results) {
        if (result.entries) next[result.dir] = result.entries;
        else errors[result.dir] = result.error || 'Could not load this folder.';
      }
      cache.current = { key, entries: next };
      setEntries(next);
      setFailures(errors);
      setLoading(false);
    });
    return () => {
      canceled = true;
    };
  }, [projectId, refresh, expanded, showIgnored]);
  const toggle = (path: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  const visible: string[] = [];
  const visit = (dir: string) =>
    entries[dir]?.forEach((entry) => {
      visible.push(entry.path);
      if (entry.directory && expanded.has(entry.path)) visit(entry.path);
    });
  visit('');
  const tabStop = visible.includes(focused) ? focused : visible[0];
  const render = (dir: string, depth: number): React.ReactNode =>
    entries[dir]?.map((entry) => (
      <div key={entry.path} role="none">
        <div className="tree-entry" role="none">
          <button
            className={`tree-row ${active === entry.path ? 'selected' : ''}`}
            style={{ paddingLeft: 14 + depth * 14 }}
            title={entry.path}
            role="treeitem"
            data-path={entry.path}
            data-name={entry.name}
            aria-level={depth + 1}
            aria-selected={active === entry.path}
            aria-label={`${entry.name}${dirtyPaths.includes(entry.path) ? ', unsaved changes' : ''}`}
            tabIndex={tabStop === entry.path ? 0 : -1}
            onFocus={() => setFocused(entry.path)}
            onKeyDown={(event) => {
              const rows = Array.from(
                tree.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') || [],
              );
              const index = rows.indexOf(event.currentTarget);
              if (event.key === 'ArrowDown') rows[Math.min(index + 1, rows.length - 1)]?.focus();
              else if (event.key === 'ArrowUp') rows[Math.max(index - 1, 0)]?.focus();
              else if (event.key === 'Home') rows[0]?.focus();
              else if (event.key === 'End') rows.at(-1)?.focus();
              else if (event.key === 'ArrowRight') {
                if (entry.directory && !expanded.has(entry.path)) toggle(entry.path);
                else if (entry.directory) rows[index + 1]?.focus();
              } else if (event.key === 'ArrowLeft') {
                if (entry.directory && expanded.has(entry.path)) toggle(entry.path);
                else if (depth > 0) {
                  const parent = entry.path.split('/').slice(0, -1).join('/');
                  rows.find((row) => row.dataset.path === parent)?.focus();
                }
              } else if (event.key === 'F2') onManage?.(entry);
              else if (
                event.key.length === 1 &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                event.key !== ' '
              ) {
                const now = Date.now();
                const text =
                  (now - typeahead.current.at < 700 ? typeahead.current.text : '') +
                  event.key.toLowerCase();
                typeahead.current = { text, at: now };
                [...rows.slice(index + 1), ...rows.slice(0, index + 1)]
                  .find((row) => row.dataset.name?.toLowerCase().startsWith(text))
                  ?.focus();
              } else return;
              event.preventDefault();
            }}
            onClick={() => (entry.directory ? toggle(entry.path) : onOpen(entry.path))}
            aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
          >
            {entry.directory ? (
              <>
                <ChevronRight size={12} className="tree-chevron" />
                <Folder size={14} />
              </>
            ) : (
              <>
                <span className="tree-indent" />
                <FileIcon name={entry.name} />
              </>
            )}
            <span>{entry.name}</span>
            {dirtyPaths.includes(entry.path) && <i className="tree-dirty" aria-hidden="true" />}
          </button>
          {onManage && (
            <button
              className="icon-button tree-manage"
              aria-label={`Manage ${entry.path}`}
              aria-haspopup="menu"
              onClick={(event) => onManage(entry, event.currentTarget)}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </div>
        {entry.directory && expanded.has(entry.path) && (
          <div className="tree-children" role="group">
            {render(entry.path, depth + 1)}
            {failures[entry.path] ? (
              <p className="tree-message tree-error" role="alert">
                {failures[entry.path]}
              </p>
            ) : !entries[entry.path] ? (
              <p className="tree-message" role="status">
                Loading folder…
              </p>
            ) : !entries[entry.path].length ? (
              <p className="tree-message">Empty folder</p>
            ) : null}
          </div>
        )}
      </div>
    ));
  return (
    <div
      className="file-tree"
      role="tree"
      aria-label="Project files"
      aria-busy={loading}
      ref={tree}
    >
      {render('', 0)}
      {loading && !entries[''] && <p className="muted inset">Loading files…</p>}
      {failures[''] && (
        <p className="tree-message tree-error" role="alert">
          {failures['']} Use Refresh files to retry.
        </p>
      )}
      {!loading && entries['']?.length === 0 && (
        <p className="muted inset">No files in this folder yet.</p>
      )}
    </div>
  );
}
