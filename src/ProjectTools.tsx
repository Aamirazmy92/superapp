import { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { AnchoredPopover } from './AnchoredPopover';
import {
  Copy,
  FilePlus2,
  FolderPlus,
  Search,
  Plus,
  Minus,
  GitBranch,
  ChevronsDownUp,
  Pencil,
  Trash2,
  Check,
  EllipsisVertical,
  ListTree,
  RefreshCw,
  X,
} from './icons';
import FileTree, { FileIcon } from './FileTree';
import Modal from './Modal';
import type { ContentMatch, Entry, GitStatus, OpenFile, Project } from './types';

export default function ProjectTools({
  project,
  section,
  refresh,
  files,
  active,
  git,
  onOpen,
  onChanged,
  onRename,
  onTrash,
  onError,
  onClose,
}: {
  project: Project;
  section: 'files' | 'search' | 'git';
  refresh: number;
  files: OpenFile[];
  active?: string;
  git: GitStatus;
  onOpen(path: string, line?: number, column?: number): void;
  onChanged(): void;
  onRename(previous: string, next: string): void;
  onTrash(path: string): void;
  onError(error: unknown): void;
  /** Hides the explorer; the header's close button is shown only when given. */
  onClose?(): void;
}) {
  const api = window.workspace!;
  const [operation, setOperation] = useState<'file' | 'folder' | 'manage' | 'delete' | null>(null);
  const [menu, setMenu] = useState<{ entry: Entry; anchor: HTMLElement } | null>(null);
  const [target, setTarget] = useState<Entry | null>(null);
  const [path, setPath] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [content, setContent] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [matches, setMatches] = useState<ContentMatch[]>([]);
  const [searchFiles, setSearchFiles] = useState<Entry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState('');
  const [diff, setDiff] = useState<{ path: string; text: string; staged: boolean } | null>(null);
  const [notice, setNotice] = useState('');
  const [showIgnored, setShowIgnored] = useState(false);
  const [collapse, setCollapse] = useState(0);
  // The Files header: a filter (a leading ? searches inside files), a tree or flat list, and a menu.
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'tree' | 'list'>(() => {
    try {
      return localStorage.getItem('explorer-view') === 'list' ? 'list' : 'tree';
    } catch {
      return 'tree';
    }
  });
  const [listing, setListing] = useState<{ entries: Entry[]; truncated: boolean } | null>(null);
  const [headMenu, setHeadMenu] = useState(false);
  const filterInput = useRef<HTMLInputElement>(null);
  const headMenuButton = useRef<HTMLButtonElement>(null);
  const headMenuList = useRef<HTMLDivElement>(null);
  const filterText = filter.trim();
  const filterContent = filterText.startsWith('?');
  // In the Files section the filter drives the same search as Find files.
  const activeQuery = section === 'files' ? (filterContent ? filterText.slice(1).trim() : filterText) : query;
  const activeContent = section === 'files' ? filterContent : content;
  const dirty =
    target &&
    files.some(
      (file) =>
        (file.path === target.path || file.path.startsWith(`${target.path}/`)) &&
        file.saved !== file.content,
    );
  useEffect(() => {
    let canceled = false;
    setMatches([]);
    setSearchFiles([]);
    setTruncated(false);
    setFailure('');
    if ((section !== 'search' && section !== 'files') || !activeQuery.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        if (activeContent) {
          const result = await api.searchContent(project.id, activeQuery, sensitive);
          if (!canceled) {
            setMatches(result.matches);
            setTruncated(result.truncated);
          }
        } else {
          const result = await api.searchFiles(project.id, activeQuery);
          if (!canceled) {
            setSearchFiles(result);
            setTruncated(result.length === 150);
          }
        }
      } catch (error) {
        if (!canceled) setFailure(String(error));
      } finally {
        if (!canceled) setSearching(false);
      }
    }, 250);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [project.id, activeQuery, activeContent, sensitive, refresh, section]);
  useEffect(() => {
    try {
      localStorage.setItem('explorer-view', view);
    } catch {}
  }, [view]);
  // The flat list: every file, walked breadth-first and capped.
  useEffect(() => {
    if (view !== 'list' || section !== 'files') return;
    let current = true;
    (async () => {
      const entries: Entry[] = [];
      const queue = [''];
      let truncated = false;
      while (queue.length && current) {
        const dir = queue.shift()!;
        let children: Entry[] = [];
        try {
          children = await api.listFiles(project.id, dir, showIgnored);
        } catch {
          continue;
        }
        for (const entry of children) {
          if (entry.directory) queue.push(entry.path);
          else entries.push(entry);
        }
        if (entries.length >= 2000) {
          truncated = true;
          break;
        }
      }
      if (!current) return;
      entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
      setListing({ entries: entries.slice(0, 2000), truncated });
    })();
    return () => {
      current = false;
    };
  }, [view, section, project.id, refresh, showIgnored]);
  useEffect(() => {
    if (!headMenu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!headMenuList.current?.contains(target) && !headMenuButton.current?.contains(target))
        setHeadMenu(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    requestAnimationFrame(() => headMenuList.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus());
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [headMenu]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.context-menu, .tree-manage')) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);
  async function copyPath(entry: Entry) {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(entry.path);
    } catch (error) {
      onError(error);
    }
  }
  function openOperation(kind: 'file' | 'folder' | 'manage' | 'delete', entry?: Entry) {
    setOperation(kind);
    setTarget(entry || null);
    const parent = active?.split('/').slice(0, -1).join('/');
    setPath(entry?.path || (parent ? `${parent}/` : ''));
    setFailure('');
  }
  async function mutate(remove = false) {
    if (busy) return;
    setBusy(true);
    setFailure('');
    try {
      if ((operation === 'manage' || operation === 'delete') && target) {
        if (remove) {
          await api.trashEntry(project.id, target.path);
          onTrash(target.path);
        } else {
          await api.renameEntry(project.id, target.path, path.trim());
          onRename(target.path, path.trim().replaceAll('\\', '/'));
        }
      } else {
        const entry = await api.createEntry(project.id, path.trim(), operation === 'folder');
        if (!entry.directory) onOpen(entry.path);
      }
      onChanged();
      setOperation(null);
    } catch (error) {
      setFailure(
        String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''),
      );
    } finally {
      setBusy(false);
    }
  }
  async function gitAction(action: () => Promise<unknown>, committed = false) {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      await action();
      if (committed) {
        setMessage('');
        setNotice('Commit created.');
      }
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  async function showDiff(relative: string, staged: boolean) {
    try {
      setDiff({ path: relative, staged, text: await api.gitDiff(project.id, relative, staged) });
    } catch (error) {
      onError(error);
    }
  }
  const title =
    operation === 'file'
      ? 'New file'
      : operation === 'folder'
        ? 'New folder'
        : operation === 'delete'
          ? 'Move to Recycle Bin'
          : 'Rename / move';
  return (
    <>
      {section === 'files' && (
        <div className="chat-files-skin">
          <header className="chat-files-head">
            <strong className="chat-files-heading">Files</strong>
            <div className="chat-files-actions">
              <button
                className="icon-button"
                aria-label="Search files"
                title="Search files"
                onClick={() => filterInput.current?.focus()}
              >
                <Search size={15} />
              </button>
              <button
                className={`icon-button chat-files-toggle ${view === 'tree' ? 'active' : ''}`}
                aria-label="Tree view"
                aria-pressed={view === 'tree'}
                title={view === 'tree' ? 'Show as a list' : 'Show as a tree'}
                onClick={() => setView(view === 'tree' ? 'list' : 'tree')}
              >
                <ListTree size={15} />
              </button>
              <button
                ref={headMenuButton}
                className={`icon-button ${headMenu ? 'active' : ''}`}
                aria-label="More file actions"
                aria-haspopup="menu"
                aria-expanded={headMenu}
                title="More"
                onClick={() => setHeadMenu(!headMenu)}
              >
                <EllipsisVertical size={15} />
              </button>
              {onClose && (
                <button className="icon-button" aria-label="Hide files" title="Hide files" onClick={onClose}>
                  <X size={15} />
                </button>
              )}
            </div>
            {headMenu && (
              <div ref={headMenuList} className="chat-files-menu" role="menu" aria-label="File actions">
                {[
                  { label: 'New file', icon: <FilePlus2 size={14} />, run: () => openOperation('file') },
                  { label: 'New folder', icon: <FolderPlus size={14} />, run: () => openOperation('folder') },
                  {
                    label: 'Show excluded folders',
                    icon: showIgnored ? <Check size={14} /> : <span className="chat-files-menu-gap" />,
                    checked: showIgnored,
                    run: () => setShowIgnored(!showIgnored),
                  },
                  { label: 'Collapse folders', icon: <ChevronsDownUp size={14} />, run: () => setCollapse((value) => value + 1) },
                  { label: 'Refresh', icon: <RefreshCw size={14} />, run: onChanged },
                ].map((item) => (
                  <button
                    key={item.label}
                    role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                    aria-checked={item.checked}
                    title={item.label === 'Show excluded folders' ? 'Include dependency folders and build output in the explorer' : undefined}
                    onClick={() => {
                      setHeadMenu(false);
                      item.run();
                    }}
                    onKeyDown={(event) => {
                      const items = [...(headMenuList.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') || [])];
                      const index = items.indexOf(event.currentTarget);
                      if (event.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
                      else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
                      else if (event.key === 'Escape') {
                        event.stopPropagation();
                        setHeadMenu(false);
                        headMenuButton.current?.focus();
                      } else return;
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
          <label className="chat-files-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={filterInput}
              type="text"
              value={filter}
              placeholder="Filter, or ? to search in files"
              aria-label="Filter files"
              spellCheck={false}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && filter) {
                  event.stopPropagation();
                  setFilter('');
                }
              }}
            />
          </label>
          {failure && (
            <p className="tool-error" role="alert">
              {failure}
            </p>
          )}
          {filterText ? (
            <div className="chat-files-results" role="list" aria-label={filterContent ? 'Matches in files' : 'Matching files'}>
              {filterContent && !activeQuery ? (
                <p className="chat-files-hint">Type after ? to search inside files.</p>
              ) : searching ? (
                <p className="chat-files-hint" role="status">Searching…</p>
              ) : filterContent ? (
                matches.length ? (
                  <>
                    {[...matches.reduce((groups, match) => groups.set(match.path, [...(groups.get(match.path) || []), match]), new Map<string, ContentMatch[]>())].map(([path, group]) => (
                      <div key={path} role="listitem" className="chat-files-group">
                        <button className="tree-row chat-files-group-head" title={path} onClick={() => onOpen(path, group[0].line, group[0].column)}>
                          <FileIcon name={path} />
                          <span>{path.split('/').pop()}</span>
                          <small>{path.split('/').slice(0, -1).join('/')}</small>
                          <em>{group.length}</em>
                        </button>
                        {group.slice(0, 20).map((match) => (
                          <button
                            key={`${match.line}:${match.column}`}
                            className="tree-row chat-files-match"
                            title={`${path}:${match.line}`}
                            onClick={() => onOpen(path, match.line, match.column)}
                          >
                            <small>{match.line}</small>
                            <span>{match.text.trim()}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                    {truncated && <p className="chat-files-hint">Showing the first matches only.</p>}
                  </>
                ) : (
                  <p className="chat-files-hint">No matches in files.</p>
                )
              ) : searchFiles.length ? (
                searchFiles.map((entry) => (
                  <button key={entry.path} className="tree-row chat-files-row" title={entry.path} onClick={() => onOpen(entry.path)}>
                    <FileIcon name={entry.name} />
                    <span>{entry.name}</span>
                    <small>{entry.path.split('/').slice(0, -1).join('/')}</small>
                  </button>
                ))
              ) : (
                <p className="chat-files-hint">No files match.</p>
              )}
            </div>
          ) : view === 'list' ? (
            <div className="chat-files-results" role="listbox" aria-label="All files">
              {!listing ? (
                <p className="chat-files-hint" role="status">Listing files…</p>
              ) : (
                <>
                  {listing.entries.map((entry) => (
                    <button key={entry.path} className="tree-row chat-files-row" role="option" aria-selected={entry.path === active} title={entry.path} onClick={() => onOpen(entry.path)}>
                      <FileIcon name={entry.name} />
                      <span>{entry.name}</span>
                      <small>{entry.path.split('/').slice(0, -1).join('/')}</small>
                    </button>
                  ))}
                  {listing.truncated && <p className="chat-files-hint">Showing the first 2000 files.</p>}
                </>
              )}
            </div>
          ) : (
            <div className="chat-files-tree">
              <FileTree
                projectId={project.id}
                active={active}
                onOpen={onOpen}
                refresh={refresh}
                showIgnored={showIgnored}
                collapse={collapse}
                folderIcons={false}
                dirtyPaths={files
                  .filter((file) => file.saved !== file.content)
                  .map((file) => file.path)}
                onError={onError}
                onManage={(entry, anchor) =>
                  anchor ? setMenu((current) => (current?.entry.path === entry.path ? null : { entry, anchor })) : openOperation('manage', entry)
                }
              />
            </div>
          )}
        </div>
      )}
      {section === 'search' && (
        <>
          <div className="tool-actions">
            <button
              aria-pressed={!content}
              className={`text-button ${!content ? 'accent' : ''}`}
              onClick={() => setContent(false)}
            >
              Filenames
            </button>
            <button
              aria-pressed={content}
              className={`text-button ${content ? 'accent' : ''}`}
              onClick={() => setContent(true)}
            >
              File contents
            </button>
          </div>
          <div className="search-field">
            <Search size={13} />
            <input
              autoFocus
              aria-label="Search project"
              placeholder={content ? 'Find text in files…' : 'Find a file…'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {content && (
            <label className="search-option">
              <input
                type="checkbox"
                checked={sensitive}
                onChange={(event) => setSensitive(event.target.checked)}
              />
              Match case
            </label>
          )}
          <p className="search-hint" role="status">
            {searching
              ? 'Searching…'
              : !query.trim()
                ? 'Enter a search term.'
                : `${content ? matches.length : searchFiles.length} results${truncated ? ' · limit reached; refine your search' : ''}`}
          </p>
          {failure && (
            <p className="tool-error" role="alert">
              {failure}
            </p>
          )}
          {searchFiles.map((entry) => (
            <button className="search-result" key={entry.path} onClick={() => onOpen(entry.path)}>
              <FileIcon name={entry.name} />
              <span>
                {entry.name}
                <small>{entry.path}</small>
              </span>
            </button>
          ))}
          {matches.map((match) => (
            <button
              className="search-result content-result"
              key={`${match.path}:${match.line}`}
              onClick={() => onOpen(match.path, match.line, match.column)}
            >
              <span>
                {match.path}:{match.line}
                <small>{match.text}</small>
              </span>
            </button>
          ))}
          {content && (
            <p className="sidebar-footnote">
              Text files up to 512 KB. Dependencies and build output are excluded.
            </p>
          )}
        </>
      )}
      {section === 'git' && (
        <>
          <div className="git-summary">
            <GitBranch size={14} />
            {git.available ? git.branch : 'No Git repository'}
          </div>
          {!git.available && (
            <p className="inset muted">
              {git.error || 'Initialize a repository in the terminal to use source control.'}
            </p>
          )}
          {git.available && (
            <>
              {([true, false] as const).map((staged) => {
                const entries = git.files.filter((entry) =>
                  staged ? ![' ', '?', '!'].includes(entry.status[0]) : entry.status[1] !== ' ',
                );
                return (
                  <section key={String(staged)} className="git-group">
                    <h3>
                      {staged ? 'Staged changes' : 'Changes'} <span>{entries.length}</span>
                    </h3>
                    {entries.map((entry) => (
                      <div className="git-entry" key={entry.path}>
                        <button
                          className="change-row"
                          title={`Review ${entry.path}`}
                          onClick={() => showDiff(entry.path, staged)}
                        >
                          <FileIcon name={entry.path} />
                          <span>{entry.path}</span>
                          <code>{entry.status === '??' ? 'U' : entry.status[staged ? 0 : 1]}</code>
                        </button>
                        <button
                          disabled={busy}
                          className="icon-button"
                          aria-label={`${staged ? 'Unstage' : 'Stage'} ${entry.path}`}
                          onClick={() =>
                            gitAction(() =>
                              staged
                                ? api.gitUnstage(project.id, entry.path)
                                : api.gitStage(project.id, entry.path),
                            )
                          }
                        >
                          {staged ? <Minus size={14} /> : <Plus size={14} />}
                        </button>
                      </div>
                    ))}
                    {!entries.length && (
                      <p className="search-hint">
                        {staged
                          ? 'Stage a change to include it in a commit.'
                          : 'No unstaged changes.'}
                      </p>
                    )}
                  </section>
                );
              })}
              <form
                className="commit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  gitAction(() => api.gitCommit(project.id, message), true);
                }}
              >
                <textarea
                  aria-label="Commit message"
                  placeholder="Commit message"
                  maxLength={10000}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
                <button
                  className="primary-button"
                  disabled={
                    busy ||
                    !message.trim() ||
                    !git.files.some((entry) => ![' ', '?', '!'].includes(entry.status[0]))
                  }
                >
                  {busy ? 'Working…' : 'Commit staged changes'}
                </button>
              </form>
              {notice && (
                <p role="status" className="inset accent">
                  {notice}
                </p>
              )}
            </>
          )}
        </>
      )}
      <AnimatePresence>
        {menu && (
          <AnchoredPopover anchor={menu.anchor} className="context-menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                openOperation('manage', menu.entry);
              }}
            >
              <Pencil size={14} />
              Rename / move
            </button>
            <button role="menuitem" onClick={() => copyPath(menu.entry)}>
              <Copy size={14} />
              Copy path
            </button>
            <button
              role="menuitem"
              className="danger-menu-item"
              onClick={() => {
                setMenu(null);
                openOperation('delete', menu.entry);
              }}
            >
              <Trash2 size={14} />
              Move to Recycle Bin
            </button>
          </AnchoredPopover>
        )}
      </AnimatePresence>
      <AnimatePresence>
      {operation && (
        <Modal
          title={title}
          onClose={() => {
            if (!busy) setOperation(null);
          }}
        >
          {operation === 'delete' ? (
            <div className="delete-confirm">
              <p>
                Move “{target?.path}”{target?.directory ? ' and everything inside it' : ''} to the
                Recycle Bin?{dirty ? ' Unsaved edits in its open tabs will be discarded.' : ''}
              </p>
              {failure && (
                <p className="tool-error" role="alert">
                  {failure}
                </p>
              )}
              <div className="tool-actions">
                <button className="danger-button" autoFocus disabled={busy} onClick={() => mutate(true)}>
                  {busy ? 'Working…' : 'Move to Recycle Bin'}
                </button>
                <button className="text-button" disabled={busy} onClick={() => setOperation(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                mutate();
              }}
            >
              <label className="field-label">
                Project-relative path
                <input
                  className="text-input"
                  autoFocus
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  aria-label="File or folder path"
                  required
                  disabled={busy}
                />
              </label>
              <p className="muted">
                {operation === 'manage'
                  ? 'Rename or move within this project. Open editor tabs follow the new path.'
                  : 'The parent folder must already exist.'}
              </p>
              {failure && (
                <p className="tool-error" role="alert">
                  {failure}
                </p>
              )}
              <div className="tool-actions">
                <button
                  className="primary-button"
                  disabled={
                    busy || !path.trim() || (operation === 'manage' && path.trim() === target?.path)
                  }
                >
                  {busy ? 'Working…' : operation === 'manage' ? 'Rename / move' : 'Create'}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      </AnimatePresence>
      <AnimatePresence>
      {diff && (
        <Modal
          title={`${diff.staged ? 'Staged' : 'Working tree'} · ${diff.path}`}
          onClose={() => setDiff(null)}
        >
          <pre className="git-diff-content">{diff.text || 'No textual changes in this view.'}</pre>
        </Modal>
      )}
      </AnimatePresence>
    </>
  );
}
