import { memo } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import type { ChatActivity as Activity } from './types';
import { DiffStat, DiffView, relativePath } from './ChatChanges';

type Verb = 'Created' | 'Deleted' | 'Edited';

function fileVerb(activity: Activity): Verb {
  const changes = activity.changes || [];
  if (changes.length && changes.every((change) => change.kind === 'add')) return 'Created';
  if (changes.length && changes.every((change) => change.kind === 'delete')) return 'Deleted';
  return 'Edited';
}

function count(n: number, one: string, many: string) {
  return n === 1 ? one : `${n} ${many}`;
}

function diffTotals(activities: Activity[]) {
  const changes = activities.flatMap((activity) => (activity.kind === 'file' ? activity.changes || [] : []));
  return {
    any: changes.length > 0,
    additions: changes.reduce((total, change) => total + change.additions, 0),
    deletions: changes.reduce((total, change) => total + change.deletions, 0),
  };
}

// "Ran a command, edited example.ts" — one clause per kind of step, in the
// order they first happened, like Claude's collapsed tool summary.
function summarize(activities: Activity[], root?: string) {
  const clauses = new Map<string, string[]>();
  const add = (key: string, item: string) => {
    if (!clauses.has(key)) clauses.set(key, []);
    const items = clauses.get(key)!;
    if (!items.includes(item)) items.push(item);
  };
  for (const activity of activities) {
    if (activity.status === 'running') continue;
    if (activity.kind === 'command') add('command', activity.id);
    else if (activity.kind === 'tool') add('tool', activity.id);
    else for (const path of activity.paths?.length ? activity.paths : [activity.title]) add(fileVerb(activity), relativePath(path, root));
  }
  const parts = [...clauses].map(([key, items]) => {
    if (key === 'command') return `ran ${count(items.length, 'a command', 'commands')}`;
    if (key === 'tool') return `used ${count(items.length, 'a tool', 'tools')}`;
    return `${key.toLowerCase()} ${items.length === 1 ? items[0].split(/[\\/]/).pop() : `${items.length} files`}`;
  });
  const running = activities.find((activity) => activity.status === 'running');
  if (running) parts.push(running.kind === 'file' ? `editing ${running.paths?.[0]?.split(/[\\/]/).pop() || 'files'}` : `running ${running.title}`);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stepTitle(activity: Activity, root?: string) {
  if (activity.kind === 'file' && activity.paths?.length)
    return `${fileVerb(activity)} ${activity.paths.map((path) => relativePath(path, root)).join(', ')}`;
  if (activity.kind === 'command') return `Ran ${activity.title}`;
  return activity.title;
}

export default memo(function ChatActivity({
  activities,
  root,
  onOpenFile,
}: {
  activities: Activity[];
  root?: string;
  onOpenFile?(path: string): void;
}) {
  if (!activities.length) return null;
  const running = activities.some((activity) => activity.status === 'running');
  const failed = activities.filter((activity) => activity.status === 'failed').length;
  const totals = diffTotals(activities);
  return (
    <details className={`chat-activities ${running ? 'running' : ''}`} aria-label="Coding activity">
      <summary className="chat-activities-summary">
        {running && <Loader2 size={13} className="spinning" aria-hidden="true" />}
        <span className="chat-activities-text">{summarize(activities, root)}</span>
        {totals.any && <DiffStat additions={totals.additions} deletions={totals.deletions} />}
        {failed > 0 && <span className="chat-activities-failed">{failed} failed</span>}
        <ChevronRight size={14} className="chat-activities-chevron" aria-hidden="true" />
      </summary>
      <div className="chat-activity-list">
        {activities.map((activity) => {
          const changes = activity.kind === 'file' ? activity.changes || [] : [];
          const stats = diffTotals([activity]);
          const hasBody = changes.length > 0 || !!activity.detail || !!activity.paths?.length;
          return (
            <details className={`chat-activity ${activity.status} ${changes.length ? 'has-diff' : ''}`} key={activity.id}>
              <summary title={activity.title} className={hasBody ? '' : 'empty'}>
                {activity.status === 'running' && <Loader2 size={12} className="spinning" aria-hidden="true" />}
                <span>{stepTitle(activity, root)}</span>
                {stats.any && <DiffStat additions={stats.additions} deletions={stats.deletions} />}
                {activity.status === 'failed' && <small>Failed</small>}
                {hasBody && <ChevronRight size={13} className="chat-activities-chevron" aria-hidden="true" />}
              </summary>
              {hasBody && (
                <div className="chat-activity-body">
                  {changes.map((change, index) => (
                    <div className="chat-activity-diff" key={index}>
                      {changes.length > 1 && <div className="chat-changes-edit-label">{relativePath(change.path, root)}</div>}
                      <DiffView change={change} compact />
                    </div>
                  ))}
                  {activity.detail && (!changes.length || activity.status === 'failed') && <pre>{activity.detail}</pre>}
                  {activity.paths?.length ? (
                    <div className="chat-changed-files">
                      {activity.paths.map((path) => (
                        <button
                          type="button"
                          key={path}
                          disabled={!onOpenFile}
                          onClick={() => onOpenFile?.(path)}
                          title={path}
                        >
                          {path.split(/[\\/]/).pop()} <span>Open file</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </details>
          );
        })}
      </div>
    </details>
  );
});
