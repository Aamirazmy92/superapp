import { useEffect, useRef } from 'react';
import { SaveAll, X } from 'lucide-react';
import { FileIcon } from './FileTree';
import { tabLabel } from './editorModel';
import type { OpenFile } from './types';

export default function FileTabs({
  files,
  active,
  busy,
  onSelect,
  onClose,
  onSaveAll,
}: {
  files: OpenFile[];
  active?: string;
  busy: boolean;
  onSelect(path: string): void;
  onClose(file: OpenFile): void;
  onSaveAll(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const dirty = files.filter((file) => file.content !== file.saved).length;
  useEffect(() => {
    host.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return (
    <div className="editor-tabbar">
      <div className="file-tabs" role="tablist" aria-label="Open files" ref={host}>
        {files.map((file, index) => {
          const label = tabLabel(
            file.path,
            files.map((item) => item.path),
          );
          const changed = file.content !== file.saved;
          return (
            <div
              className={`file-tab ${file.path === active ? 'active' : ''}`}
              key={file.path}
              role="presentation"
            >
              <button
                role="tab"
                aria-selected={file.path === active}
                tabIndex={file.path === active ? 0 : -1}
                aria-label={`${label}${changed ? ', unsaved changes' : ''}`}
                title={`${file.path}${changed ? ' • Unsaved changes' : ''}`}
                onClick={() => onSelect(file.path)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % files.length;
                  else if (event.key === 'ArrowLeft')
                    next = (index + files.length - 1) % files.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = files.length - 1;
                  else if (event.key === 'Delete') {
                    event.preventDefault();
                    onClose(file);
                    return;
                  } else return;
                  event.preventDefault();
                  onSelect(files[next].path);
                  host.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}
              >
                <FileIcon name={file.path} />
                <span className="file-tab-label">{label}</span>
                {changed && <span className="dirty-dot" aria-hidden="true" />}
              </button>
              <button
                aria-label={`Close ${label}`}
                title={`Close ${file.path}`}
                disabled={busy}
                onClick={() => onClose(file)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        className="icon-button save-all-button"
        aria-label="Save all files"
        title={`Save all files${dirty ? ` (${dirty} unsaved)` : ''} • Ctrl+Shift+S`}
        disabled={busy || !dirty}
        onClick={onSaveAll}
      >
        <SaveAll size={15} />
        {dirty > 0 && <span>{dirty}</span>}
      </button>
    </div>
  );
}
