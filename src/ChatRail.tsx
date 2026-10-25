import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, FileDiff, Folder, GitBranch, Laptop } from './icons';
import { DiffStat, type ChangedFile } from './ChatChanges';
import type { Project } from './types';

function Card({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="chat-rail-card">
      <button type="button" className="chat-rail-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <ChevronDown size={13} className={open ? '' : 'closed'} aria-hidden="true" />
      </button>
      {open && <div className="chat-rail-card-body">{children}</div>}
    </section>
  );
}

export default function ChatRail({
  project,
  files,
  onReview,
}: {
  project?: Project;
  files: ChangedFile[];
  onReview(): void;
}) {
  const [branch, setBranch] = useState('');
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) {
      setBranch('');
      return;
    }
    let current = true;
    window.workspace
      ?.gitStatus(projectId)
      .then((status) => current && setBranch(status.available ? status.branch : ''))
      .catch(() => current && setBranch(''));
    return () => {
      current = false;
    };
  }, [projectId, files.length]);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const drive = /^[A-Za-z]:/.test(project?.root || '') ? project!.root.slice(0, 2) : '';
  return (
    <aside className="chat-rail" aria-label="Session details">
      <Card title="Environment">
        <div className="chat-rail-row">
          <Laptop size={15} aria-hidden="true" />
          <span>Local</span>
        </div>
        <div className="chat-rail-row" title={project?.root}>
          <Folder size={15} aria-hidden="true" />
          <span>{project?.name || 'No project'}</span>
          {drive && <small>· {drive}</small>}
        </div>
        {branch && (
          <div className="chat-rail-row">
            <GitBranch size={15} aria-hidden="true" />
            <span>{branch}</span>
          </div>
        )}
      </Card>
      <Card title="Changes">
        {files.length ? (
          <div className="chat-rail-row changes">
            <FileDiff size={15} aria-hidden="true" />
            <DiffStat additions={additions} deletions={deletions} />
            <small>{files.length} {files.length === 1 ? 'file' : 'files'}</small>
            <button type="button" className="chat-rail-button" onClick={onReview}>
              Review
            </button>
          </div>
        ) : (
          <p className="chat-rail-empty">No file changes in this chat yet.</p>
        )}
      </Card>
    </aside>
  );
}
