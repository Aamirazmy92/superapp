import { memo, useMemo, useState } from 'react';
import { ExternalLink, FileDiff, FileMinus, FilePen, FilePlus } from 'lucide-react';
import Modal from './Modal';
import type { ChatActivity, ChatFileChange } from './types';

export type ChangedFile = {
  path: string;
  kind: ChatFileChange['kind'];
  additions: number;
  deletions: number;
  edits: ChatFileChange[];
};

const fileKey = (path: string) => path.replaceAll('\\', '/').toLowerCase();

export function relativePath(path: string, root?: string) {
  const normalized = path.replaceAll('\\', '/');
  const base = root?.replaceAll('\\', '/').replace(/\/$/, '');
  return base && normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)
    ? normalized.slice(base.length + 1)
    : normalized;
}

// Groups every successful edit by file, in the order the agent made them.
export function collectChanges(activities: ChatActivity[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const activity of activities) {
    if (activity.kind !== 'file' || activity.status === 'failed') continue;
    for (const change of activity.changes || []) {
      const key = fileKey(change.path);
      const file = files.get(key);
      if (!file) {
        files.set(key, {
          path: change.path,
          kind: change.kind,
          additions: change.additions,
          deletions: change.deletions,
          edits: [change],
        });
        continue;
      }
      file.additions += change.additions;
      file.deletions += change.deletions;
      file.edits.push(change);
      if (change.kind === 'delete') file.kind = 'delete';
      else if (file.kind === 'delete') file.kind = 'update';
    }
  }
  return [...files.values()];
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stat">
      <span className="diff-stat-add">+{additions}</span>
      <span className="diff-stat-del">−{deletions}</span>
    </span>
  );
}

export const DiffView = memo(function DiffView({
  change,
  compact,
}: {
  change: ChatFileChange;
  compact?: boolean;
}) {
  const rows = useMemo(() => {
    let oldLine = 0;
    let newLine = 0;
    let numbered = false;
    return change.diff.split('\n').map((line) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (line.startsWith('@@')) {
        numbered = !!hunk;
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
        }
        return { type: 'hunk', text: line, old: '', new: '' };
      }
      const type = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
      const row = {
        type,
        text: line.slice(1),
        old: numbered && type !== 'add' ? String(oldLine) : '',
        new: numbered && type !== 'del' ? String(newLine) : '',
      };
      if (numbered) {
        if (type !== 'add') oldLine++;
        if (type !== 'del') newLine++;
      }
      return row;
    });
  }, [change.diff]);
  if (!change.diff)
    return <p className="chat-diff-empty">No line changes to show.</p>;
  return (
    <div className={`chat-diff ${compact ? 'compact' : ''}`} role="table" aria-label={`Changes to ${change.path}`}>
      {rows.map((row, index) =>
        row.type === 'hunk' ? (
          <div className="chat-diff-row hunk" role="row" key={index}>
            <span className="chat-diff-text" role="cell">{row.text === '@@' ? '⋯' : row.text}</span>
          </div>
        ) : (
          <div className={`chat-diff-row ${row.type}`} role="row" key={index}>
            <span className="chat-diff-num" role="cell" aria-hidden="true">{row.old}</span>
            <span className="chat-diff-num" role="cell" aria-hidden="true">{row.new}</span>
            <span className="chat-diff-sign" role="cell" aria-hidden="true">
              {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}
            </span>
            <span className="chat-diff-text" role="cell">{row.text || ' '}</span>
          </div>
        ),
      )}
      {change.truncated && <p className="chat-diff-empty">Diff truncated — open the file to see everything.</p>}
    </div>
  );
});

export function ChangesSummary({ files, onReview }: { files: ChangedFile[]; onReview(): void }) {
  if (!files.length) return null;
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  return (
    <div className="chat-changes-summary">
      <FileDiff size={14} aria-hidden="true" />
      <span>
        {files.length} {files.length === 1 ? 'file' : 'files'} changed
      </span>
      <DiffStat additions={additions} deletions={deletions} />
      <button type="button" className="chat-changes-review" onClick={onReview}>
        Review changes
      </button>
    </div>
  );
}

const kindIcon = { add: FilePlus, update: FilePen, delete: FileMinus };
const kindLabel = { add: 'Added', update: 'Modified', delete: 'Deleted' };

export function ChangesDialog({
  title,
  files,
  root,
  onOpenFile,
  onClose,
}: {
  title: string;
  files: ChangedFile[];
  root?: string;
  onOpenFile?(path: string): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState(files[0]?.path);
  const file = files.find((item) => item.path === selected) || files[0];
  const additions = files.reduce((total, item) => total + item.additions, 0);
  const deletions = files.reduce((total, item) => total + item.deletions, 0);
  return (
    <Modal title={title} onClose={onClose} className="chat-changes-modal">
      {!files.length ? (
        <p className="muted">No file changes in this conversation yet.</p>
      ) : (
        <div className="chat-changes-layout">
          <nav className="chat-changes-files" aria-label="Changed files">
            <div className="chat-changes-total">
              {files.length} {files.length === 1 ? 'file' : 'files'}
              <DiffStat additions={additions} deletions={deletions} />
            </div>
            {files.map((item) => {
              const shown = relativePath(item.path, root);
              const slash = shown.lastIndexOf('/');
              const Icon = kindIcon[item.kind];
              return (
                <button
                  type="button"
                  key={item.path}
                  className={`chat-changes-file ${item === file ? 'active' : ''} ${item.kind}`}
                  aria-current={item === file ? 'true' : undefined}
                  title={`${kindLabel[item.kind]} · ${shown}`}
                  onClick={() => setSelected(item.path)}
                >
                  <Icon size={14} aria-label={kindLabel[item.kind]} />
                  <span className="chat-changes-name">
                    <b>{shown.slice(slash + 1)}</b>
                    {slash > 0 && <small>{shown.slice(0, slash)}</small>}
                  </span>
                  <DiffStat additions={item.additions} deletions={item.deletions} />
                </button>
              );
            })}
          </nav>
          {file && (
            <section className="chat-changes-detail" aria-label={relativePath(file.path, root)}>
              <header>
                <span title={file.path}>{relativePath(file.path, root)}</span>
                <small>
                  {kindLabel[file.kind]} · {file.edits.length} {file.edits.length === 1 ? 'edit' : 'edits'}
                </small>
                {onOpenFile && file.kind !== 'delete' && (
                  <button type="button" className="secondary-button" onClick={() => onOpenFile(file.path)}>
                    <ExternalLink size={13} aria-hidden="true" /> Open file
                  </button>
                )}
              </header>
              <div className="chat-changes-diffs">
                {file.edits.map((edit, index) => (
                  <div key={index}>
                    {file.edits.length > 1 && <div className="chat-changes-edit-label">Edit {index + 1}</div>}
                    <DiffView change={edit} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
