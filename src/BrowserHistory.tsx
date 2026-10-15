import { useEffect, useMemo, useState } from 'react';
import { Globe, Search, X } from './icons';
import type { BrowserHistoryEntry, BrowserHistoryRange } from './types';

const RANGES: { value: BrowserHistoryRange; label: string }[] = [
  { value: 'hour', label: 'Last hour' },
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 4 weeks' },
  { value: 'all', label: 'All time' },
];
const DATA_KINDS = [
  { key: 'history', label: 'Browsing history', detail: 'Visited pages, and the back and forward list of every open tab' },
  { key: 'siteData', label: 'Cookies and other site data', detail: 'Signs you out of most sites' },
  { key: 'cache', label: 'Cached images and files', detail: 'Some sites may load more slowly next time' },
] as const;
type DataKind = (typeof DATA_KINDS)[number]['key'];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
function dayLabel(time: number) {
  const day = new Date(time);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return 'Today';
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(day.getFullYear() !== today.getFullYear() && { year: 'numeric' }),
  });
}

// Pages visited in the built-in browser, by day, and Chrome's "Clear browsing
// data". Visits are recorded by electron/main.cjs.
export default function BrowserHistory({
  onOpen,
  onClose,
}: {
  // `newTab` for Ctrl+click and middle click; the history stays open.
  onOpen(url: string, newTab: boolean): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<BrowserHistoryEntry[] | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  const [range, setRange] = useState<BrowserHistoryRange>('hour');
  const [kinds, setKinds] = useState<Record<DataKind, boolean>>({ history: true, siteData: false, cache: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const workspace = window.workspace;
    if (!workspace) return;
    let cancelled = false;
    const load = () => workspace.browserHistory(query)
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch((failure) => { if (!cancelled) setError(errorText(failure)); });
    void load();
    const stop = workspace.onBrowserHistoryChanged(() => void load());
    return () => { cancelled = true; stop(); };
  }, [query]);

  const groups = useMemo(() => {
    const result: { label: string; entries: BrowserHistoryEntry[] }[] = [];
    for (const entry of entries ?? []) {
      const label = dayLabel(entry.visitedAt);
      const last = result.at(-1);
      if (last?.label === label) last.entries.push(entry);
      else result.push({ label, entries: [entry] });
    }
    return result;
  }, [entries]);

  async function remove(entry: BrowserHistoryEntry) {
    setError('');
    setStatus('');
    setEntries((current) => current?.filter((item) => item.id !== entry.id) ?? null);
    try {
      await window.workspace?.removeBrowserHistory([entry.id]);
    } catch (failure) {
      setError(errorText(failure));
      // Show what is actually saved.
      void window.workspace?.browserHistory(query).then(setEntries).catch(() => {});
    }
  }

  async function clearData() {
    if (busy || !Object.values(kinds).some(Boolean)) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await window.workspace?.clearBrowsingData({ range, ...kinds });
      const cleared = DATA_KINDS.filter(({ key }) => kinds[key]).map(({ label }) => label.toLowerCase());
      const list = cleared.length > 1 ? `${cleared.slice(0, -1).join(', ')} and ${cleared.at(-1)}` : cleared[0];
      setStatus(`Cleared ${list}.${kinds.siteData ? ' You may need to sign in to sites again.' : ' Site sign-ins kept.'}`);
      setClearOpen(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  const allTimeOnly = range !== 'all' && (kinds.siteData || kinds.cache);

  return (
    <div
      className="browser-history"
      role="region"
      aria-label="History"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (clearOpen) setClearOpen(false);
        else onClose();
      }}
    >
      <div className="browser-history-header">
        <label className="browser-history-search">
          <Search size={14} />
          <input
            autoFocus
            type="search"
            aria-label="Search history"
            placeholder="Search history"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="text-button"
          aria-expanded={clearOpen}
          onClick={() => { setClearOpen((open) => !open); setStatus(''); }}
        >
          Clear browsing data…
        </button>
        <button type="button" className="icon-button" aria-label="Close history" title="Close history (Esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {clearOpen && (
        <form
          className="browser-clear-data"
          aria-label="Clear browsing data"
          onSubmit={(event) => { event.preventDefault(); void clearData(); }}
        >
          <label className="browser-clear-range">
            Time range
            <select
              className="text-input"
              value={range}
              onChange={(event) => setRange(event.target.value as BrowserHistoryRange)}
            >
              {RANGES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {DATA_KINDS.map(({ key, label, detail }) => (
            <label key={key} className="browser-clear-kind">
              <input
                type="checkbox"
                checked={kinds[key]}
                onChange={(event) => setKinds((current) => ({ ...current, [key]: event.target.checked }))}
              />
              <span>
                {label}
                <small>{detail}</small>
              </span>
            </label>
          ))}
          {allTimeOnly && (
            <p className="browser-clear-note">Cookies, site data and cached files are cleared for all time.</p>
          )}
          <div className="browser-clear-actions">
            <button type="button" className="secondary-button" onClick={() => setClearOpen(false)}>Cancel</button>
            <button type="submit" className="danger-button" disabled={busy || !Object.values(kinds).some(Boolean)}>
              {busy ? 'Clearing…' : 'Clear data'}
            </button>
          </div>
        </form>
      )}
      {error && <div className="browser-error" role="alert">{error}</div>}
      {status && <div className="browser-status" role="status">{status}</div>}
      <div className="browser-history-list">
        {entries && !entries.length && (
          <div className="preview-empty">
            <p>{query.trim() ? 'No pages in your history match this search.' : 'Pages you visit appear here.'}</p>
          </div>
        )}
        {groups.map((group) => (
          <section key={group.label} className="browser-history-day" aria-label={group.label}>
            <h3>{group.label}</h3>
            <ul>
              {group.entries.map((entry) => {
                const name = entry.title || host(entry.url);
                return (
                  <li key={entry.id} className="browser-history-entry">
                    <time dateTime={new Date(entry.visitedAt).toISOString()}>
                      {new Date(entry.visitedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </time>
                    <button
                      type="button"
                      className="browser-history-open"
                      title={`${entry.url}\nCtrl+click to open in a new tab`}
                      onClick={(event) => onOpen(entry.url, event.ctrlKey || event.metaKey)}
                      onAuxClick={(event) => { if (event.button === 1) onOpen(entry.url, true); }}
                    >
                      <Globe size={13} />
                      <span className="browser-history-title">{name}</span>
                      <span className="browser-history-host">{host(entry.url)}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${name} from history`}
                      title="Remove from history"
                      onClick={() => void remove(entry)}
                    >
                      <X size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
