import { useEffect, useState } from 'react';
import { Search } from './icons';
import { Backdrop, MotionDialog } from './motion';
import { FileIcon } from './FileTree';
import type { Entry, OpenFile } from './types';

export default function QuickOpen({
  projectId,
  openFiles,
  onOpen,
  onClose,
  onCommands,
}: {
  projectId: string;
  openFiles: OpenFile[];
  onOpen(path: string): void;
  onClose(): void;
  onCommands(): void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let canceled = false;
    setSelected(0);
    setFailure('');
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      window
        .workspace!.searchFiles(projectId, query.trim())
        .then((items) => {
          if (canceled) return;
          const term = query.trim().toLowerCase();
          setResults(
            items
              .sort((a, b) => {
                const rank = (entry: Entry) =>
                  entry.name.toLowerCase().startsWith(term)
                    ? 0
                    : entry.name.toLowerCase().includes(term)
                      ? 1
                      : 2;
                return rank(a) - rank(b) || a.path.length - b.path.length;
              })
              .slice(0, 50),
          );
        })
        .catch((error) => {
          if (canceled) return;
          setResults([]);
          setFailure(
            String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''),
          );
        })
        .finally(() => {
          if (!canceled) setSearching(false);
        });
    }, 120);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [projectId, query]);
  const items = query.trim()
    ? results
    : [...openFiles].reverse().map((file) => ({
        path: file.path,
        name: file.path.split('/').pop() || file.path,
        directory: false,
      }));
  const choose = (path: string) => {
    onClose();
    onOpen(path);
  };
  return (
    <Backdrop
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <MotionDialog
        smoothHeight
        className="command-modal quick-open"
        role="dialog"
        aria-modal="true"
        aria-label="Quick open file"
      >
        <div className="command-input">
          <Search size={18} />
          <input
            autoFocus
            aria-label="Find file by name or path"
            placeholder="Find a file by name or path…"
            value={query}
            onChange={(event) => {
              // Earlier matches stay up, dimmed, until the new search returns;
              // clearing them flashed the list empty on every keystroke.
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                onCommands();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((index) =>
                  Math.max(
                    0,
                    Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                  ),
                );
              }
              if (event.key === 'Enter' && !searching && items[selected])
                choose(items[selected].path);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className={`command-list ${searching && items.length ? 'stale' : ''}`}>
          {!query.trim() && <p className="quick-open-heading">Open files</p>}
          {items.map((entry, index) => (
            <button
              key={entry.path}
              className={selected === index ? 'command-selected' : ''}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(entry.path)}
            >
              <FileIcon name={entry.name} />
              <span className="quick-open-path">
                <strong>{entry.name}</strong>
                <small>{entry.path}</small>
              </span>
            </button>
          ))}
          {searching && !items.length && (
            <p className="muted inset" role="status">
              Searching files…
            </p>
          )}
          {failure && (
            <p className="tool-error inset" role="alert">
              {failure}
            </p>
          )}
          {!searching && !failure && !items.length && (
            <p className="muted inset">
              {query ? 'No matching files.' : 'Type to find a file in this project.'}
            </p>
          )}
        </div>
        <div className="command-footer">Enter to open · ↑↓ to navigate · Ctrl K for commands</div>
      </MotionDialog>
    </Backdrop>
  );
}
