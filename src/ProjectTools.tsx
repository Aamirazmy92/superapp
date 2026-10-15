import { useEffect, useState } from 'react';
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
    if (section !== 'search' || !query.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        if (content) {
          const result = await api.searchContent(project.id, query, sensitive);
          if (!canceled) {
            setMatches(result.matches);
            setTruncated(result.truncated);
          }
        } else {
          const result = await api.searchFiles(project.id, query);
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
  }, [project.id, query, content, sensitive, refresh, section]);
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
        <>
          <div className="tool-actions">
            <button className="text-button" onClick={() => openOperation('file')}>
              <FilePlus2 size={14} />
              New file
            </button>
            <button className="text-button" onClick={() => openOperation('folder')}>
              <FolderPlus size={14} />
              New folder
            </button>
          </div>
          <div className="tree-controls">
            <label title="Include dependency folders and build output in the explorer">
              <input
                type="checkbox"
                checked={showIgnored}
                onChange={(event) => setShowIgnored(event.target.checked)}
              />
              Show excluded folders
            </label>
            <button
              className="icon-button"
              aria-label="Collapse all folders"
              title="Collapse all folders"
              onClick={() => setCollapse((value) => value + 1)}
            >
              <ChevronsDownUp size={14} />
            </button>
          </div>
          <FileTree
            projectId={project.id}
            active={active}
            onOpen={onOpen}
            refresh={refresh}
            showIgnored={showIgnored}
            collapse={collapse}
            dirtyPaths={files
              .filter((file) => file.saved !== file.content)
              .map((file) => file.path)}
            onError={onError}
            onManage={(entry, anchor) =>
              anchor ? setMenu((current) => (current?.entry.path === entry.path ? null : { entry, anchor })) : openOperation('manage', entry)
            }
          />
        </>
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
