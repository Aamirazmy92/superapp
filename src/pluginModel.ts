import type { InstalledPlugin, PluginCatalogEntry, PluginChangeSet, PluginKind, PluginPreviewRequest, PluginUpdateDiff } from './types';

const kindLabels: Record<PluginKind, [one: string, many: string]> = {
  commands: ['command', 'commands'],
  agents: ['agent preset', 'agent presets'],
  prompts: ['prompt', 'prompts'],
  skills: ['skill', 'skills'],
  mcpServers: ['MCP server', 'MCP servers'],
  themes: ['theme', 'themes'],
};

/** "2 commands · 1 theme", or "Nothing to add" for an empty plugin. */
export function countsLabel(counts: Partial<Record<PluginKind, number>> | undefined) {
  const parts = (Object.keys(kindLabels) as PluginKind[])
    .filter((kind) => (counts?.[kind] || 0) > 0)
    .map((kind) => `${counts![kind]} ${kindLabels[kind][counts![kind] === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(' · ') : 'Nothing to add';
}

/** IPC errors arrive as "Error invoking remote method 'x': Error: message". */
export function errorMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': /, '').replace(/^(?:Plugin)?Error: /, '');
}

/** A command line for display only. Arguments with spaces are shown quoted. */
export function commandLine(program: string, args: string[]) {
  return [program, ...args].map((part) => (/\s/.test(part) || !part ? `"${part}"` : part)).join(' ');
}

export function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 12) : '';
}

export function sourceLabel(plugin: Pick<InstalledPlugin, 'marketplace' | 'source'>) {
  const source = plugin.source;
  if (source.kind === 'local') return source.path;
  if (source.kind === 'git') return source.path ? `${source.url} (${source.path})` : source.url;
  return `${source.marketplace} marketplace`;
}

export function scopeLabel(scope: 'user' | 'project', projectName?: string) {
  return scope === 'user' ? 'All projects' : projectName ? `Only ${projectName}` : 'One project';
}

const changeSetEmpty = (set: PluginChangeSet) => !set.added.length && !set.removed.length && !set.changed.length;

/** Lines describing what an update changes, for the confirmation step. */
export function describeUpdate(diff: PluginUpdateDiff) {
  const lines: string[] = [];
  if (diff.fromVersion !== diff.toVersion) lines.push(`Version ${diff.fromVersion ?? 'unknown'} → ${diff.toVersion}`);
  for (const kind of ['commands', 'agents', 'mcpServers'] as const) {
    const set = diff[kind];
    if (changeSetEmpty(set)) continue;
    const [one, many] = kindLabels[kind];
    const name = (list: string[]) => `${list.length === 1 ? one : many} ${list.join(', ')}`;
    if (set.added.length) lines.push(`Adds ${name(set.added)}`);
    if (set.changed.length) lines.push(`Changes ${name(set.changed)}`);
    if (set.removed.length) lines.push(`Removes ${name(set.removed)}`);
  }
  return lines.length ? lines : ['No changes to commands, agent presets or MCP servers.'];
}

/** Relative time for "last updated" labels. */
export function updatedLabel(iso: string | undefined, now = Date.now()) {
  if (!iso) return 'Never';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'Unknown';
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/*
 * Prompt text from a plugin is untrusted. Before it is typed into a terminal,
 * drop control characters (an ESC could end the bracketed paste early and turn
 * the rest into keystrokes) and wrap it in a bracketed paste with no Enter.
 */
export function terminalPaste(body: string) {
  const clean = body.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  return `\u001b[200~${clean}\u001b[201~`;
}

/** Prompt bodies without leading blank lines; `$ARGUMENTS` placeholders are left for the person to fill. */
export function promptText(body: string) {
  return body.replace(/^\s*\n/, '').trimEnd();
}

/** Plugin search: names, taglines, provider, description, tags and marketplace; optionally one category. */
export function filterCatalog(entries: PluginCatalogEntry[], query: string, category: string) {
  const needle = query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (!category || entry.category === category) &&
      (!needle ||
        [entry.name, entry.displayName, entry.tagline, entry.provider, entry.description, entry.marketplace, entry.author, entry.category, ...entry.tags].some(
          (text) => !!text && text.toLowerCase().includes(needle),
        )),
  );
}

export function catalogCategories(entries: PluginCatalogEntry[]) {
  return [...new Set(entries.map((entry) => entry.category).filter(Boolean))].sort();
}

/** Where to fetch a newer copy of an installed plugin from. */
export function updateRequest(plugin: Pick<InstalledPlugin, 'source'>): PluginPreviewRequest {
  const source = plugin.source;
  if (source.kind === 'marketplace') return { kind: 'marketplace', marketplace: source.marketplace, name: source.name };
  if (source.kind === 'git') return { kind: 'git', url: source.url, ...(source.ref && { ref: source.ref }) };
  return { kind: 'local', path: source.path };
}

export function marketplaceSourceLabel(source: { kind: 'local'; path: string } | { kind: 'git'; url: string }) {
  return source.kind === 'local' ? source.path : source.url;
}

type StorefrontCatalog = {
  marketplaces: { name: string; builtin?: boolean; sections: { id: string; title: string; plugins: string[] }[] }[];
  plugins: PluginCatalogEntry[];
};
/*
 * The Public tab: the built-in catalog's curated sections in order, then every
 * plugin it lists under "All plugins". Invalid entries are left out.
 */
export function storefrontSections(catalog: StorefrontCatalog, publicName: string | null) {
  if (!publicName) return [];
  const market = catalog.marketplaces.find((item) => item.name === publicName);
  const entries = catalog.plugins.filter((entry) => entry.marketplace === publicName && !entry.error);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const sections = (market?.sections || [])
    .map((section) => ({
      id: section.id,
      title: section.title,
      entries: section.plugins.map((name) => byName.get(name)).filter((entry): entry is PluginCatalogEntry => !!entry),
    }))
    .filter((section) => section.entries.length);
  const all = [...entries].sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
  return all.length ? [...sections, { id: 'all', title: 'All plugins', entries: all }] : sections;
}

/** Initials and a stable colour for plugins without an icon. */
export function monogram(name: string) {
  const words = name.replace(/[-_]+/g, ' ').trim().split(/\s+/);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { letters, hue: hash % 360 };
}
