const crypto = require('node:crypto');

// Pages visited in the built-in browser, newest first, kept like Chrome's
// history: one entry per visit, except that revisiting the page just shown
// (a reload, a redirect back, an in-page change) updates that entry.
const MAX_ENTRIES = 5000;
const MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const MAX_URL = 4096;
const MAX_TITLE = 500;
const RANGES = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 28 * 24 * 60 * 60 * 1000,
  all: Infinity,
};

const recordable = (value) => {
  if (typeof value !== 'string' || value.length > MAX_URL) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
};
const cleanTitle = (title) => (typeof title === 'string' ? title.trim().slice(0, MAX_TITLE) : '');

function normalizeEntries(value, now) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.id === 'string' && recordable(entry.url)
      && Number.isFinite(entry.visitedAt) && entry.visitedAt > now - MAX_AGE)
    .map(({ id, url, visitedAt, title }) => ({ id, url, title: cleanTitle(title), visitedAt }))
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, MAX_ENTRIES);
}

/**
 * `load` resolves to the saved entries (or throws when there are none) and
 * `save` writes them; `onChange` runs after every change.
 */
function createBrowserHistory({ load, save, onChange = () => {}, now = Date.now, saveDelay = 400 }) {
  let entries;
  let loading;
  let timer;
  let saving = Promise.resolve();
  const ready = () => (loading ||= Promise.resolve()
    .then(load)
    .catch(() => [])
    .then((saved) => { entries = normalizeEntries(saved, now()); }));
  const write = () => {
    clearTimeout(timer);
    timer = undefined;
    const snapshot = entries.slice();
    saving = saving.catch(() => {}).then(() => save(snapshot));
    return saving;
  };
  // Visits are saved shortly after, so a title arriving after its page is
  // written once; deletions are written before they are reported done.
  const changed = (immediate) => {
    onChange();
    if (immediate) return write();
    clearTimeout(timer);
    timer = setTimeout(() => void write().catch(() => {}), saveDelay);
  };

  return {
    async record(url, title) {
      if (!recordable(url)) return;
      await ready();
      const time = now();
      const latest = entries[0];
      if (latest?.url === url) {
        latest.visitedAt = time;
        if (cleanTitle(title)) latest.title = cleanTitle(title);
      } else {
        entries.unshift({ id: crypto.randomUUID(), url, title: cleanTitle(title), visitedAt: time });
      }
      const cutoff = time - MAX_AGE;
      entries = entries.filter((entry) => entry.visitedAt > cutoff).slice(0, MAX_ENTRIES);
      changed(false);
    },
    // Titles usually arrive after the visit was recorded.
    async retitle(url, title) {
      const text = cleanTitle(title);
      if (!text || !recordable(url)) return;
      await ready();
      const entry = entries.slice(0, 20).find((item) => item.url === url);
      if (!entry || entry.title === text) return;
      entry.title = text;
      changed(false);
    },
    async list(query = '', limit = 1000) {
      await ready();
      const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      const matches = terms.length
        ? entries.filter((entry) => {
          const text = `${entry.title} ${entry.url}`.toLowerCase();
          return terms.every((term) => text.includes(term));
        })
        : entries;
      return matches.slice(0, limit).map((entry) => ({ ...entry }));
    },
    async remove(ids) {
      await ready();
      const doomed = new Set(ids);
      const kept = entries.filter((entry) => !doomed.has(entry.id));
      if (kept.length === entries.length) return;
      entries = kept;
      await changed(true);
    },
    async clear(range) {
      if (!Object.hasOwn(RANGES, range)) throw new Error('Choose a time range to clear.');
      await ready();
      const since = now() - RANGES[range];
      entries = range === 'all' ? [] : entries.filter((entry) => entry.visitedAt < since);
      await changed(true);
    },
    // Writes a visit still waiting to be saved.
    flush: () => (timer ? write() : saving),
  };
}

module.exports = { createBrowserHistory, HISTORY_RANGES: Object.keys(RANGES) };
