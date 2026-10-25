import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type * as monaco from 'monaco-editor';
import {
  ChevronsDownUp,
  EllipsisVertical,
  FilePlus,
  FolderOpen,
  FolderPlus,
  ListTree,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  X,
} from './icons';
import FileTree, { FileIcon } from './FileTree';
import { editorPath } from './editorModel';
import type { Preferences } from './preferences';
import type { ContentMatch, Entry, OpenFile } from './types';

const FileEditor = lazy(() =>
  import('./EditorSurfaces').then((module) => ({ default: module.FileEditor })),
);
// The chat pane keeps its own editor models, apart from the Code view's.
const SCHEME = 'veyo-chat';
// Below this width the editor and the tree take turns instead of sitting side by side.
const NARROW = 400;
const TREE_MIN = 170;
const TREE_MAX = 420;
const clean = (error: unknown) =>
  String(error).replace(/^Error:.*?Error: /, '').replace(/^Error: /, '');
const baseName = (path: string) => path.split('/').pop() || path;
const dirName = (path: string) => path.split('/').slice(0, -1).join('/');

type Docs = { files: OpenFile[]; active: string | null };
type Leave = { close: string };

function readNumber(key: string, fallback: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** Shown when the chat has no project, so the pane never opens onto nothing. */
export function ChatFilesEmpty({ onClose }: { onClose(): void }) {
  return (
    <section className="chat-files chat-side-pane" aria-label="Project files">
      <header className="chat-files-top">
        <strong className="chat-files-heading">Files</strong>
        <div className="chat-files-actions">
          <button className="icon-button" aria-label="Close files" title="Close files" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>
      <p className="chat-files-empty">Choose a project for this chat to browse its files.</p>
    </section>
  );
}

/**
 * The files of the project this chat works in, laid out like Claude Code's
 * Files pane: open files as tabs with an editor on the left, the tree with a
 * filter (or `?` for a search inside files) on the right. Saves are checked
 * against each file's revision and never touch the Code view's tabs.
 */
export default function ChatFiles({
  projectId,
  projectName,
  preferences,
  expanded,
  openRequest,
  onToggleExpand,
  onClose,
}: {
  projectId: string;
  projectName: string;
  preferences: Preferences;
  expanded: boolean;
  /** A file to open, e.g. a path clicked in the conversation; `nonce` makes repeats count. */
  openRequest?: { path: string; line?: number; nonce: number } | null;
  onToggleExpand(): void;
  onClose(): void;
}) {
  const api = window.workspace!;
  // Open tabs per project, so switching chats never drops unsaved edits.
  const [docs, setDocs] = useState<Record<string, Docs>>({});
  const current = docs[projectId] ?? { files: [], active: null };
  const file = current.files.find((item) => item.path === current.active) ?? null;
  const isDirty = (item: OpenFile) => item.content !== item.saved;
  const dirtyPaths = current.files.filter(isDirty).map((item) => item.path);
  const dirty = !!file && isDirty(file);
  const [refresh, setRefresh] = useState(0);
  const [collapse, setCollapse] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [leave, setLeave] = useState<Leave | null>(null);
  const [wrap, setWrap] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [nameResults, setNameResults] = useState<Entry[] | null>(null);
  const [contentResults, setContentResults] = useState<{ matches: ContentMatch[]; truncated: boolean } | null>(null);
  const [treeShown, setTreeShown] = useState(() => {
    try {
      return localStorage.getItem('chat-files-tree') !== 'hidden';
    } catch {
      return true;
    }
  });
  const [treeWidth, setTreeWidth] = useState(() => readNumber('chat-files-tree-width', 240));
  const [narrow, setNarrow] = useState(false);
  // In a narrow pane the editor and the tree take turns; this is which one is up.
  const [narrowView, setNarrowView] = useState<'tree' | 'editor'>('tree');
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState<{ directory: boolean } | null>(null);
  const [newName, setNewName] = useState('');
  const [reveal, setReveal] = useState<{ path: string; line: number; column: number } | null>(null);
  const saving = useRef(false);
  const pane = useRef<HTMLElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const setDoc = (id: string, update: (doc: Docs) => Docs) =>
    setDocs((previous) => ({ ...previous, [id]: update(previous[id] ?? { files: [], active: null }) }));
  const setFile = (id: string, path: string, update: (item: OpenFile) => OpenFile) =>
    setDoc(id, (doc) => ({ ...doc, files: doc.files.map((item) => (item.path === path ? update(item) : item)) }));

  // Models of files that are no longer open are released; all of them when the pane goes away.
  const openKey = Object.entries(docs)
    .flatMap(([id, doc]) => doc.files.map((item) => editorPath(id, item.path, SCHEME)))
    .join('\n');
  useEffect(() => {
    void import('./EditorSurfaces').then((module) =>
      module.releaseClosedEditorModels(openKey ? openKey.split('\n') : [], SCHEME),
    );
  }, [openKey]);
  useEffect(
    () => () => {
      void import('./EditorSurfaces').then((module) => module.releaseClosedEditorModels([], SCHEME));
    },
    [],
  );
  useEffect(() => {
    setError('');
    setNotice('');
    setLeave(null);
    setQuery('');
    setCreating(null);
    setMenuOpen(false);
  }, [projectId]);
  useEffect(() => store('chat-files-tree', treeShown ? 'shown' : 'hidden'), [treeShown]);
  useEffect(() => store('chat-files-tree-width', String(treeWidth)), [treeWidth]);
  // The pane decides between side by side and one at a time from its own width.
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return;
    const measure = () => setNarrow(element.getBoundingClientRect().width < NARROW);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!openRequest) return;
    open(openRequest.path, openRequest.line);
  }, [openRequest?.nonce]);

  // Plain text filters names; a leading `?` searches inside files.
  const text = query.trim();
  const contentQuery = text.startsWith('?') ? text.slice(1).trim() : null;
  useEffect(() => {
    setNameResults(null);
    setContentResults(null);
    if (!text || contentQuery === '') return;
    let live = true;
    const timer = setTimeout(
      () => {
        const fail = (value: unknown) => {
          if (live) setError(clean(value));
        };
        if (contentQuery !== null)
          api.searchContent(projectId, contentQuery, false).then(
            (found) => live && setContentResults(found),
            (value) => {
              fail(value);
              if (live) setContentResults({ matches: [], truncated: false });
            },
          );
        else
          api.searchFiles(projectId, text).then(
            (found) => live && setNameResults(found.filter((entry) => !entry.directory)),
            (value) => {
              fail(value);
              if (live) setNameResults([]);
            },
          );
      },
      contentQuery !== null ? 260 : 150,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, projectId, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !menuButton.current?.contains(target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [menuOpen]);

  async function open(path: string, line?: number, column?: number) {
    const id = projectId;
    setNarrowView('editor');
    setReveal(line ? { path, line, column: column || 1 } : null);
    if (current.files.some((item) => item.path === path)) {
      setDoc(id, (doc) => ({ ...doc, active: path }));
      // Already open: just move to the match.
      const editor = editorRef.current;
      if (editor && line && file?.path === path) {
        editor.setPosition({ lineNumber: line, column: column || 1 });
        editor.revealLineInCenter(line);
        editor.focus();
      }
      return;
    }
    try {
      setError('');
      const disk = await api.readFile(id, path);
      setDoc(id, (doc) => ({
        files: doc.files.some((item) => item.path === path)
          ? doc.files
          : [...doc.files, { ...disk, path, saved: disk.content }],
        active: path,
      }));
    } catch (value) {
      setError(clean(value));
    }
  }
  function removeTab(id: string, path: string) {
    setDoc(id, (doc) => {
      const index = doc.files.findIndex((item) => item.path === path);
      const files = doc.files.filter((item) => item.path !== path);
      return {
        files,
        active: doc.active === path ? (files[Math.min(index, files.length - 1)]?.path ?? null) : doc.active,
      };
    });
  }
  function closeTab(path: string) {
    const target = current.files.find((item) => item.path === path);
    if (target && isDirty(target)) {
      setDoc(projectId, (doc) => ({ ...doc, active: path }));
      setLeave({ close: path });
      return;
    }
    removeTab(projectId, path);
  }
  async function save(keepMine = false, target = file): Promise<boolean> {
    if (!target || saving.current) return false;
    const id = projectId;
    saving.current = true;
    setBusy(true);
    try {
      const result = await api.saveFile(
        id,
        target.path,
        target.content,
        keepMine && target.conflict ? target.conflict.revision : target.revision,
      );
      setFile(id, target.path, (item) =>
        result.conflict
          ? { ...item, conflict: { content: result.content!, revision: result.revision } }
          : { ...item, saved: target.content, revision: result.revision, conflict: undefined },
      );
      if (!result.conflict) {
        setError('');
        setNotice(`Saved ${baseName(target.path)}`);
        setRefresh((value) => value + 1);
      }
      return !result.conflict;
    } catch (value) {
      setError(clean(value));
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function finishLeave(choice: 'save' | 'discard' | 'cancel') {
    const pending = leave;
    if (!pending) return;
    setLeave(null);
    if (choice === 'cancel') return;
    const target = current.files.find((item) => item.path === pending.close);
    if (choice === 'save' && !(await save(false, target ?? null))) return;
    removeTab(projectId, pending.close);
  }
  async function create() {
    const name = newName.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!creating || !name) return;
    try {
      setError('');
      await api.createEntry(projectId, name, creating.directory);
      setCreating(null);
      setNewName('');
      setRefresh((value) => value + 1);
      if (!creating.directory) void open(name);
      else setNotice(`Created ${baseName(name)}`);
    } catch (value) {
      setError(clean(value));
    }
  }
  function startTreeResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = treeWidth;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('panel-resizing');
    // The tree is on the right, so dragging left widens it.
    const move = (next: PointerEvent) =>
      setTreeWidth(Math.round(Math.max(TREE_MIN, Math.min(TREE_MAX, startWidth + startX - next.clientX))));
    const end = () => {
      document.body.classList.remove('panel-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    event.preventDefault();
  }

  const shown = useMemo(
    () => ({ ...preferences, wordWrap: wrap ?? preferences.wordWrap, minimap: false }),
    [preferences, wrap],
  );
  const grouped = useMemo(() => {
    const groups = new Map<string, ContentMatch[]>();
    for (const match of contentResults?.matches || [])
      groups.set(match.path, [...(groups.get(match.path) || []), match]);
    return [...groups.entries()];
  }, [contentResults]);
  // Wide: editor and tree side by side. Narrow: one at a time, the tree toggle switching.
  const hasFiles = current.files.length > 0;
  const showTree = narrow ? narrowView === 'tree' || !hasFiles : treeShown;
  const showViewer = narrow ? !showTree : true;

  const menuItems: { label: string; icon: ReactNode; run(): void }[] = [
    { label: 'New file', icon: <FilePlus size={14} />, run: () => setCreating({ directory: false }) },
    { label: 'New folder', icon: <FolderPlus size={14} />, run: () => setCreating({ directory: true }) },
    { label: 'Refresh', icon: <RefreshCw size={14} />, run: () => setRefresh((value) => value + 1) },
    { label: 'Collapse folders', icon: <ChevronsDownUp size={14} />, run: () => setCollapse((value) => value + 1) },
  ];

  return (
    <section
      ref={pane}
      className={`chat-files chat-side-pane ${narrow ? 'narrow' : ''}`}
      aria-label="Project files"
      onKeyDown={(event) => {
        // Saving here is about this file, never a file open in the Code view.
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          event.stopPropagation();
          if (!event.shiftKey) void save();
          return;
        }
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (event.target instanceof Element && event.target.closest('.monaco-editor')) return;
        event.stopPropagation();
        if (menuOpen) {
          setMenuOpen(false);
          menuButton.current?.focus();
        } else if (leave) setLeave(null);
        else if (creating) setCreating(null);
        else if (query) setQuery('');
        else onClose();
      }}
    >
      <header className="chat-files-top">
        {hasFiles ? (
          <div className="chat-files-tabs" role="tablist" aria-label="Open files">
            {current.files.map((item) => (
              <div
                key={item.path}
                className={`chat-files-tab ${item.path === current.active ? 'active' : ''}`}
                title={item.path}
              >
                <button
                  role="tab"
                  aria-selected={item.path === current.active}
                  onClick={() => setDoc(projectId, (doc) => ({ ...doc, active: item.path }))}
                  onAuxClick={(event) => {
                    if (event.button === 1) closeTab(item.path);
                  }}
                >
                  <FileIcon name={item.path} />
                  <span>{baseName(item.path)}</span>
                  {isDirty(item) && <i className="chat-files-dot" aria-label="unsaved changes" />}
                </button>
                <button
                  className="chat-files-tab-close"
                  aria-label={`Close ${baseName(item.path)}`}
                  title="Close"
                  onClick={() => closeTab(item.path)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <strong className="chat-files-heading">Files</strong>
        )}
        <div className="chat-files-actions">
          <button
            className="icon-button"
            aria-label="Search files"
            title="Search files"
            onClick={() => {
              setTreeShown(true);
              setNarrowView('tree');
              requestAnimationFrame(() => filterInput.current?.focus());
            }}
          >
            <Search size={15} />
          </button>
          <button
            className={`icon-button chat-files-toggle ${showTree ? 'active' : ''}`}
            aria-label="File tree"
            aria-pressed={showTree}
            title={showTree ? 'Hide the file tree' : 'Show the file tree'}
            onClick={() => (narrow ? setNarrowView(showTree ? 'editor' : 'tree') : setTreeShown(!showTree))}
          >
            <ListTree size={15} />
          </button>
          <button
            ref={menuButton}
            className={`icon-button ${menuOpen ? 'active' : ''}`}
            aria-label="More file actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <EllipsisVertical size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={expanded ? 'Restore files' : 'Expand files'}
            aria-pressed={expanded}
            title={expanded ? 'Restore' : 'Expand'}
            onClick={onToggleExpand}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-button" aria-label="Close files" title="Close files" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        {menuOpen && (
          <div ref={menu} className="chat-files-menu" role="menu" aria-label="File actions">
            {menuItems.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  if (item.label.startsWith('New')) {
                    setTreeShown(true);
                    setNarrowView('tree');
                  }
                  item.run();
                }}
                onKeyDown={(event) => {
                  const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])];
                  const index = items.indexOf(event.currentTarget);
                  if (event.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
                  else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
                  else return;
                  event.preventDefault();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </header>
      {leave && (
        <div className="chat-files-leave" role="alertdialog" aria-label="Unsaved changes">
          <span>Save your changes to {baseName(leave.close)}?</span>
          <div>
            <button className="chat-rail-button" disabled={busy} onClick={() => void finishLeave('save')}>
              Save
            </button>
            <button className="chat-rail-button" disabled={busy} onClick={() => void finishLeave('discard')}>
              Discard
            </button>
            <button className="chat-rail-button" onClick={() => void finishLeave('cancel')}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="chat-files-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="chat-files-notice" role="status">
          {notice}
        </p>
      )}
      <div className="chat-files-columns">
        {showViewer && (
          <div className="chat-files-viewer">
            {file ? (
              <div className="chat-files-editor">
                <Suspense fallback={<span className="muted inset editor-loading">Loading editor…</span>}>
                  <FileEditor
                    projectId={projectId}
                    modelScheme={SCHEME}
                    file={file}
                    preferences={shown}
                    busy={busy}
                    editorRef={editorRef}
                    reveal={reveal}
                    onChange={(content) => setFile(projectId, file.path, (item) => ({ ...item, content }))}
                    onSave={(keepMine) => void save(keepMine)}
                    onWrap={() => setWrap(!shown.wordWrap)}
                    onUseDisk={() =>
                      setFile(projectId, file.path, (item) =>
                        item.conflict
                          ? { ...item, ...item.conflict, saved: item.conflict.content, conflict: undefined }
                          : item,
                      )
                    }
                  />
                </Suspense>
              </div>
            ) : (
              <div className="chat-files-placeholder">
                <FolderOpen size={22} aria-hidden="true" />
                <strong>Open files appear here</strong>
                <span>Pick a file in the tree, or click a file path in the conversation.</span>
              </div>
            )}
          </div>
        )}
        {showViewer && showTree && (
          <div
            className="chat-side-handle vertical"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            aria-valuenow={treeWidth}
            aria-valuemin={TREE_MIN}
            aria-valuemax={TREE_MAX}
            tabIndex={0}
            onPointerDown={startTreeResize}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const step = event.key === 'ArrowLeft' ? 16 : -16;
              setTreeWidth((value) => Math.max(TREE_MIN, Math.min(TREE_MAX, value + step)));
            }}
          />
        )}
        {showTree && (
          <div
            className={`chat-files-browser ${showViewer ? 'sized' : ''}`}
            style={showViewer ? { width: treeWidth } : undefined}
          >
            <label className="chat-files-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={filterInput}
                type="text"
                value={query}
                placeholder="Filter, or ? to search in files"
                aria-label="Filter files"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {creating && (
              <form
                className="chat-files-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
              >
                {creating.directory ? <FolderPlus size={14} aria-hidden="true" /> : <FilePlus size={14} aria-hidden="true" />}
                <input
                  autoFocus
                  value={newName}
                  aria-label={creating.directory ? 'New folder path' : 'New file path'}
                  placeholder={creating.directory ? 'folder/name' : 'folder/name.ts'}
                  spellCheck={false}
                  onChange={(event) => setNewName(event.target.value)}
                />
              </form>
            )}
            {contentQuery !== null ? (
              <div className="chat-files-results" role="list" aria-label="Matches in files">
                {!contentQuery ? (
                  <p className="chat-files-hint">Type after ? to search inside files.</p>
                ) : !contentResults ? (
                  <p className="chat-files-hint" role="status">Searching…</p>
                ) : !grouped.length ? (
                  <p className="chat-files-hint">No matches in files.</p>
                ) : (
                  <>
                    {grouped.map(([path, matches]) => (
                      <div key={path} role="listitem" className="chat-files-group">
                        <button
                          className="tree-row chat-files-group-head"
                          title={path}
                          onClick={() => void open(path, matches[0].line, matches[0].column)}
                        >
                          <FileIcon name={path} />
                          <span>{baseName(path)}</span>
                          <small>{dirName(path)}</small>
                          <em>{matches.length}</em>
                        </button>
                        {matches.slice(0, 20).map((match) => (
                          <button
                            key={`${match.line}:${match.column}`}
                            className="tree-row chat-files-match"
                            title={`${path}:${match.line}`}
                            onClick={() => void open(path, match.line, match.column)}
                          >
                            <small>{match.line}</small>
                            <span>{match.text.trim()}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                    {contentResults.truncated && <p className="chat-files-hint">Showing the first matches only.</p>}
                  </>
                )}
              </div>
            ) : text ? (
              <div className="chat-files-results" role="listbox" aria-label="Matching files">
                {!nameResults ? (
                  <p className="chat-files-hint" role="status">Filtering…</p>
                ) : nameResults.length ? (
                  nameResults.map((entry) => (
                    <button
                      key={entry.path}
                      className="tree-row chat-files-row"
                      role="option"
                      aria-selected={entry.path === current.active}
                      title={entry.path}
                      onClick={() => void open(entry.path)}
                    >
                      <FileIcon name={entry.name} />
                      <span>{entry.name}</span>
                      <small>{dirName(entry.path)}</small>
                    </button>
                  ))
                ) : (
                  <p className="chat-files-hint">No files match.</p>
                )}
              </div>
            ) : (
              <div className="chat-files-tree">
                <FileTree
                  projectId={projectId}
                  active={current.active ?? undefined}
                  refresh={refresh}
                  collapse={collapse}
                  showIgnored
                  folderIcons={false}
                  dirtyPaths={dirtyPaths}
                  onOpen={(path) => void open(path)}
                  onError={(value) => setError(clean(value))}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <span className="sr-only">{projectName}</span>
    </section>
  );
}
