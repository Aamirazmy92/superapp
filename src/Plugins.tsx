import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Modal from './Modal';
import { Switch } from './Switch';
import MarkdownMessage from './MarkdownMessage';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  UserSetup,
} from './icons';
import {
  commandLine,
  countsLabel,
  describeUpdate,
  errorMessage,
  filterCatalog,
  marketplaceSourceLabel,
  monogram,
  scopeLabel,
  shortSha,
  sourceLabel,
  storefrontSections,
  updateRequest,
  updatedLabel,
} from './pluginModel';
import type {
  InstalledPlugin,
  McpCli,
  McpAuth,
  McpConnection,
  McpPlan,
  PluginCatalog,
  PluginCatalogEntry,
  PluginContributes,
  PluginDetail,
  PluginPreview,
  PluginPreviewRequest,
  PluginsState,
  TerminalInfo,
} from './types';

type Tab = 'public' | 'personal';
type View =
  | { kind: 'list' }
  | { kind: 'details'; key: string }
  | { kind: 'consent'; preview: PluginPreview; entry?: PluginCatalogEntry }
  | { kind: 'sheet'; preview: PluginPreview; entry?: PluginCatalogEntry }
  | { kind: 'settings' }
  | { kind: 'git' };
type Toast = (message: string, action?: { label: string; run(): void }) => void;
const CLIS: McpCli[] = ['claude', 'codex'];
type McpServer = PluginContributes['mcpServers'][number];

/*
 * Plugins: Veyo's public catalog (Public), what you have installed and the
 * marketplaces you added (Personal). Plugins that only add prompts, skills or
 * themes install with one click; anything that can run commands, launch agents
 * or connect MCP servers opens a sheet listing exactly what it runs first.
 */
export default function Plugins({
  projectId,
  projectName,
  workspaceName,
  onClose,
  onToast,
  onTerminal,
}: {
  projectId: string | null;
  projectName?: string;
  workspaceName?: string;
  onClose(): void;
  onToast: Toast;
  /** Terminals the dialog opened (adding MCP servers, signing in); the app shows them. */
  onTerminal(info: TerminalInfo[]): void;
}) {
  const api = window.workspace!;
  const [tab, setTab] = useState<Tab>('public');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [state, setState] = useState<PluginsState | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [working, setWorking] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const viewRef = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);
  // Each view replaces the last, so focus moves into it: otherwise it falls back
  // to the page and Escape and Tab stop working in the dialog.
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    viewRef.current?.querySelector<HTMLElement>('[data-autofocus], button:not(:disabled), input, [tabindex="0"]')?.focus();
  }, [view.kind, view.kind === 'details' ? view.key : '']);

  const cancelPreview = () => {
    if (view.kind === 'consent' || view.kind === 'sheet') api.pluginsCancelPreview(view.preview.previewId).catch(() => {});
  };
  const close = () => {
    cancelPreview();
    onClose();
  };
  // A button disabled while it had focus drops focus to the page, where the
  // dialog no longer hears Escape or Tab. Pick both up there and bring focus back.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        viewRef.current?.querySelector<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refresh = useCallback(() => {
    api
      .pluginsState(projectId)
      .then((value) => {
        setState(value);
        setLoadError('');
      })
      .catch((reason) => setLoadError(errorMessage(reason)));
    api
      .pluginsCatalog()
      .then(setCatalog)
      .catch((reason) => setLoadError(errorMessage(reason)));
  }, [api, projectId]);
  useEffect(() => {
    refresh();
    return api.onPluginsChanged(refresh);
  }, [api, refresh]);

  const installedByKey = useMemo(() => new Map((state?.plugins || []).map((item) => [item.key, item])), [state]);
  const entryFor = useCallback(
    (item: Pick<InstalledPlugin, 'id'>) => catalog?.plugins.find((entry) => entry.id === item.id),
    [catalog],
  );

  /** "+" and "Update": stage the plugin, then install at once or open the sheet. */
  async function install(entry: PluginCatalogEntry) {
    if (working) return;
    setError('');
    setWorking(entry.id);
    try {
      const preview = await api.pluginsPreview({ kind: 'marketplace', marketplace: entry.marketplace, name: entry.name });
      const blocked = preview.conflict || (!preview.plugin.compatible ? `${entry.displayName} needs Veyo ${preview.plugin.minAppVersion} or later.` : '');
      if (blocked) {
        api.pluginsCancelPreview(preview.previewId).catch(() => {});
        setError(blocked);
        return;
      }
      if (preview.risk === 'none') {
        const updating = preview.installed.some((item) => item.scope === 'user');
        const result = await api.pluginsInstall(preview.previewId, 'user');
        onToast(
          `${updating ? 'Updated' : 'Installed'} ${entry.displayName}`,
          updating ? undefined : { label: 'Undo', run: () => api.pluginsUninstall(result.key).catch(() => {}) },
        );
        return;
      }
      setView({ kind: 'sheet', preview, entry });
    } catch (reason) {
      setError(`${entry.displayName} can't be installed. ${errorMessage(reason)}`);
    } finally {
      setWorking('');
    }
  }
  /** Opens the full review for a source (folder, Git address, details' update check). */
  async function review(request: PluginPreviewRequest, failure: string, entry?: PluginCatalogEntry) {
    setError('');
    setWorking('review');
    try {
      setView({ kind: 'consent', preview: await api.pluginsPreview(request), entry });
    } catch (reason) {
      setError(`${failure} ${errorMessage(reason)}`);
    } finally {
      setWorking('');
    }
  }
  async function installFolder() {
    const folder = await api.pluginsPickFolder().catch(() => null);
    if (folder) await review({ kind: 'local', path: folder }, "This folder can't be installed as a plugin.");
  }
  const toggle = async (item: InstalledPlugin, enabled: boolean) => {
    setError('');
    try {
      await api.pluginsSetEnabled(item.key, enabled);
      onToast(`${enabled ? 'Enabled' : 'Disabled'} ${item.name}`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const backToList = () => {
    cancelPreview();
    setView({ kind: 'list' });
  };
  const rowProps = {
    working,
    installedByKey,
    onInstall: install,
    onOpen: (entry: PluginCatalogEntry) => {
      const mine = entry.installed[0];
      if (mine) setView({ kind: 'details', key: mine.key });
      else review({ kind: 'marketplace', marketplace: entry.marketplace, name: entry.name }, `${entry.displayName} can't be installed.`, entry);
    },
    onToggle: toggle,
    onDetails: (key: string) => setView({ kind: 'details', key }),
  };

  let body: ReactNode;
  if (view.kind === 'consent') {
    body = (
      <Consent
        preview={view.preview}
        entry={view.entry}
        projectId={projectId}
        projectName={projectName}
        onCancel={backToList}
        onInstalled={(message) => {
          onToast(message);
          setView({ kind: 'list' });
        }}
      />
    );
  } else if (view.kind === 'sheet') {
    body = (
      <InstallSheet
        preview={view.preview}
        entry={view.entry}
        projectId={projectId}
        projectName={projectName}
        workspaceName={workspaceName}
        onCancel={backToList}
        onFullReview={() => setView({ kind: 'consent', preview: view.preview, entry: view.entry })}
        onDone={(message, terminals) => {
          onToast(message);
          setView({ kind: 'list' });
          if (terminals.length) onTerminal(terminals);
        }}
      />
    );
  } else if (view.kind === 'details') {
    const entry = installedByKey.get(view.key);
    body = (
      <Details
        key={view.key}
        entry={entry}
        listing={entry && entryFor(entry)}
        projectId={projectId}
        projectName={projectName}
        workspaceName={workspaceName}
        working={working}
        onBack={() => setView({ kind: 'list' })}
        onToast={onToast}
        onUpdate={(item) => review(updateRequest(item), `Could not check ${item.name} for an update.`)}
        onTerminal={onTerminal}
      />
    );
  } else if (view.kind === 'settings') {
    body = <Marketplaces catalog={catalog} loadError={loadError} onBack={() => setView({ kind: 'list' })} onToast={onToast} />;
  } else if (view.kind === 'git') {
    body = (
      <GitInstall
        busy={working === 'review'}
        onBack={() => setView({ kind: 'list' })}
        onReview={(url, ref) => review({ kind: 'git', url, ...(ref && { ref }) }, 'Could not install from that Git address.')}
      />
    );
  } else {
    const searching = !!query.trim();
    body = (
      <>
        <div className="plugins-header">
          <p className="plugins-subtitle">Add tools, integrations, prompts and themes to your workspace.</p>
          <div className="plugins-header-actions">
            <label className="plugins-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="Search plugins"
                placeholder="Search plugins"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              className="icon-button"
              aria-label="Refresh the catalog"
              title="Refresh the catalog"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                setError('');
                try {
                  await api.pluginsRefreshPublic();
                } catch (reason) {
                  setError(`Could not refresh the Veyo catalog. ${errorMessage(reason)}`);
                } finally {
                  setRefreshing(false);
                  refresh();
                }
              }}
            >
              <RefreshCw size={15} className={refreshing ? 'spinning' : undefined} />
            </button>
            <button className="icon-button" aria-label="Manage marketplaces" title="Manage marketplaces" onClick={() => setView({ kind: 'settings' })}>
              <Settings2 size={15} />
            </button>
            <AddMenu
              disabled={!!working}
              onFolder={installFolder}
              onGit={() => setView({ kind: 'git' })}
              onMarketplace={() => setView({ kind: 'settings' })}
            />
          </div>
        </div>
        {!searching && (
          <div className="plugins-pills" role="tablist" aria-label="Plugin sections">
            {(['public', 'personal'] as Tab[]).map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  const next = id === 'public' ? 'personal' : 'public';
                  setTab(next);
                  (event.currentTarget.parentElement?.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
                }}
                data-tab={id}
              >
                {id === 'public' ? 'Public' : 'Personal'}
                {id === 'personal' && !!state?.plugins.length && <span className="plugins-tab-count">{state.plugins.length}</span>}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="tool-error" role="alert">
            <AlertCircle size={14} /> {error}
          </p>
        )}
        <div className="plugins-panel" role={searching ? undefined : 'tabpanel'} aria-label={searching ? 'Search results' : tab === 'public' ? 'Public' : 'Personal'}>
          {loadError ? (
            <p className="tool-error" role="alert">
              {loadError}
            </p>
          ) : !catalog || !state ? (
            <Loading label="Loading the Veyo catalog…" />
          ) : searching ? (
            <SearchResults catalog={catalog} query={query} {...rowProps} />
          ) : tab === 'public' ? (
            <PublicTab catalog={catalog} onRetry={() => api.pluginsRefreshPublic().then(refresh, (reason) => setError(errorMessage(reason)))} {...rowProps} />
          ) : (
            <PersonalTab catalog={catalog} state={state} entryFor={entryFor} projectName={projectName} onSettings={() => setView({ kind: 'settings' })} {...rowProps} />
          )}
        </div>
      </>
    );
  }
  return (
    <Modal title="Plugins" className="plugins-modal" onClose={close}>
      <div ref={viewRef} className="plugins-view">
        {body}
      </div>
    </Modal>
  );
}

function Spinner() {
  return <LoaderCircle size={14} className="spinning" aria-hidden="true" />;
}
function Loading({ label }: { label: string }) {
  return (
    <p className="plugins-empty" aria-busy="true">
      <Spinner /> {label}
    </p>
  );
}

/** The Add menu: install from a folder or Git address, or add a marketplace. */
function AddMenu({ disabled, onFolder, onGit, onMarketplace }: { disabled: boolean; onFolder(): void; onGit(): void; onMarketplace(): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <div className="plugins-add" ref={ref}>
      <button
        className="secondary-button plugins-add-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
          }
        }}
      >
        Add <ChevronDown size={13} />
      </button>
      {open && (
        <div
          className="plugins-menu"
          role="menu"
          aria-label="Add"
          onKeyDown={(event) => {
            const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])];
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
              ref.current?.querySelector<HTMLElement>('.plugins-add-button')?.focus();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
            }
          }}
        >
          <button role="menuitem" onClick={() => choose(onFolder)}>
            <FolderOpen size={14} /> From folder…
          </button>
          <button role="menuitem" onClick={() => choose(onGit)}>
            <GitBranch size={14} /> From Git address…
          </button>
          <button role="menuitem" onClick={() => choose(onMarketplace)}>
            <Plus size={14} /> Add marketplace…
          </button>
        </div>
      )}
    </div>
  );
}

/** A brand icon, its dark-theme variant, or a monogram tile. */
function PluginIcon({ name, icon, iconDark, size = 40 }: { name: string; icon?: string | null; iconDark?: string | null; size?: number }) {
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme !== 'light';
  const source = (dark && iconDark) || icon;
  if (source)
    return (
      <span className="plugins-icon" style={{ width: size, height: size }} aria-hidden="true">
        <img src={source} alt="" draggable={false} />
      </span>
    );
  const { letters, hue } = monogram(name);
  return (
    <span className="plugins-icon plugins-icon-monogram" style={{ width: size, height: size, background: `hsl(${hue} 45% 32%)` }} aria-hidden="true">
      {letters}
    </span>
  );
}

type RowProps = {
  working: string;
  installedByKey: Map<string, InstalledPlugin>;
  onInstall(entry: PluginCatalogEntry): void;
  onOpen(entry: PluginCatalogEntry): void;
  onToggle(item: InstalledPlugin, enabled: boolean): void;
  onDetails(key: string): void;
};

/** One storefront row: icon, name and tagline, and the one action that fits. */
function CatalogRow({ entry, working, installedByKey, onInstall, onOpen, onToggle, onDetails }: RowProps & { entry: PluginCatalogEntry }) {
  const mine = entry.installed.map((item) => installedByKey.get(item.key)).find(Boolean);
  const name = entry.displayName || entry.name;
  let action: ReactNode;
  if (working === entry.id) action = <span className="plugins-row-busy" role="status" aria-label={`Installing ${name}`}><Spinner /></span>;
  else if (entry.error)
    action = (
      <span className="plugins-row-icon-action plugins-row-invalid" title={entry.error} aria-label={`${name} cannot be installed: ${entry.error}`} role="img">
        <AlertCircle size={16} />
      </span>
    );
  else if (mine && entry.updateAvailable)
    action = (
      <button className="secondary-button plugins-small-button" disabled={!!working} onClick={() => onInstall(entry)} aria-label={`Update ${name}`}>
        Update
      </button>
    );
  else if (mine) action = <RowMenu name={name} item={mine} onToggle={onToggle} onDetails={onDetails} />;
  else if (entry.setup !== 'none')
    action = (
      <button className="plugins-row-icon-action" disabled={!!working} onClick={() => onInstall(entry)} aria-label={`Set up ${name}`} title={setupHint(entry)}>
        <UserSetup size={17} />
      </button>
    );
  else
    action = (
      <button className="plugins-row-icon-action" disabled={!!working} onClick={() => onInstall(entry)} aria-label={`Install ${name}`} title={`Install ${name}`}>
        <Plus size={17} />
      </button>
    );
  return (
    <li className={`plugins-card${mine && !mine.enabled ? ' plugins-card-off' : ''}`}>
      <button className="plugins-card-main" onClick={() => onOpen(entry)} aria-label={`${name}${entry.provider ? `, by ${entry.provider}` : ''}: ${entry.tagline}`}>
        <PluginIcon name={name} icon={entry.icon} iconDark={entry.iconDark} />
        <span className="plugins-card-text">
          <strong>
            {name}
            {mine && !entry.updateAvailable && <Check size={13} className="plugins-installed-mark" aria-label="Installed" />}
            {entry.updateAvailable && <span className="plugins-dot" aria-label="Update available" />}
          </strong>
          <span>{entry.tagline || entry.description}</span>
        </span>
      </button>
      <span className="plugins-card-action">{action}</span>
    </li>
  );
}
function setupHint(entry: PluginCatalogEntry) {
  return entry.setup === 'oauth-client'
    ? `Needs your own ${entry.provider || ''} OAuth client`.replace('  ', ' ')
    : entry.setup === 'token'
      ? 'Needs an access token'
      : 'Sign in after installing';
}

/** The "…" menu of an installed plugin. */
function RowMenu({ name, item, onToggle, onDetails }: { name: string; item: InstalledPlugin; onToggle(item: InstalledPlugin, enabled: boolean): void; onDetails(key: string): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <span className="plugins-row-menu" ref={ref}>
      <button
        className="plugins-row-icon-action"
        aria-label={`${name} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
        }}
      >
        <MoreHorizontal size={17} />
      </button>
      {open && (
        <span
          className="plugins-menu"
          role="menu"
          aria-label={`${name} options`}
          onKeyDown={(event) => {
            const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])];
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
              ref.current?.querySelector<HTMLElement>('button')?.focus();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
            }
          }}
        >
          <button role="menuitem" onClick={() => choose(() => onDetails(item.key))}>
            Details
          </button>
          <button role="menuitem" onClick={() => choose(() => onToggle(item, !item.enabled))}>
            {item.enabled ? 'Disable' : 'Enable'}
          </button>
          <button role="menuitem" className="plugins-menu-danger" onClick={() => choose(() => onDetails(item.key))}>
            Uninstall…
          </button>
        </span>
      )}
    </span>
  );
}

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  const id = `plugins-section-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section className="plugins-section" aria-labelledby={id}>
      <h3 id={id}>
        {title}
        {count !== undefined && <span className="plugins-section-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function PublicTab({ catalog, onRetry, ...rowProps }: RowProps & { catalog: PluginCatalog; onRetry(): void }) {
  const sections = storefrontSections(catalog, catalog.publicName);
  if (!catalog.publicName)
    return (
      <div className="plugins-empty">
        <strong>The Veyo catalog could not be loaded</strong>
        <span>{catalog.publicError || 'It is downloaded the first time you open Plugins.'}</span>
        {!catalog.gitAvailable && <span>Git is not installed or not on PATH; Veyo uses it to download the catalog.</span>}
        <button className="secondary-button" onClick={onRetry}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    );
  return (
    <>
      {catalog.publicError && (
        <p className="plugins-note">
          <AlertCircle size={13} /> Showing the last downloaded catalog. {catalog.publicError}
        </p>
      )}
      {sections.map((section) => (
        <Section key={section.id} title={section.title}>
          <ul className="plugins-grid" aria-label={section.title}>
            {section.entries.map((entry) => (
              <CatalogRow key={entry.id} entry={entry} {...rowProps} />
            ))}
          </ul>
        </Section>
      ))}
    </>
  );
}

function SearchResults({ catalog, query, ...rowProps }: RowProps & { catalog: PluginCatalog; query: string }) {
  const results = filterCatalog(catalog.plugins, query, '').filter((entry) => !entry.error);
  return (
    <Section title="Results" count={results.length}>
      {results.length ? (
        <ul className="plugins-grid" aria-label="Search results">
          {results.map((entry) => (
            <CatalogRow key={entry.id} entry={entry} {...rowProps} />
          ))}
        </ul>
      ) : (
        <p className="plugins-empty">No plugins match “{query.trim()}”.</p>
      )}
    </Section>
  );
}

function PersonalTab({
  catalog,
  state,
  entryFor,
  projectName,
  onSettings,
  ...rowProps
}: RowProps & {
  catalog: PluginCatalog;
  state: PluginsState;
  entryFor(item: InstalledPlugin): PluginCatalogEntry | undefined;
  projectName?: string;
  onSettings(): void;
}) {
  const own = catalog.marketplaces.filter((market) => !market.builtin);
  return (
    <>
      <Section title="Installed" count={state.plugins.length}>
        {!state.plugins.length ? (
          <p className="plugins-empty">Nothing installed yet. Plugins you install appear here.</p>
        ) : (
          <ul className="plugins-list" aria-label="Installed plugins">
            {state.plugins.map((item) => {
              const listing = entryFor(item);
              const name = listing?.displayName || item.name;
              return (
                <li key={item.key} className="plugins-row">
                  <button className="plugins-card-main" onClick={() => rowProps.onDetails(item.key)} aria-label={`${name} details`}>
                    <PluginIcon name={name} icon={listing?.icon} iconDark={listing?.iconDark} size={32} />
                    <span className="plugins-card-text">
                      <strong>
                        {name} <span className="plugins-version">{item.version}</span>
                        {item.updateAvailable && <span className="plugins-badge plugins-badge-accent">Update available</span>}
                        {item.error && <span className="plugins-badge plugins-badge-error">Invalid</span>}
                        {item.plugin && !item.plugin.compatible && <span className="plugins-badge plugins-badge-error">Needs Veyo {item.plugin.minAppVersion}</span>}
                        {item.enabled && !item.active && !item.error && item.plugin?.compatible && <span className="plugins-badge">Not active here</span>}
                      </strong>
                      <span>
                        {item.error ||
                          [
                            scopeLabel(item.scope, item.scope === 'project' ? projectName : undefined),
                            countsLabel(item.plugin?.counts),
                            item.connections.length ? `Added to ${[...new Set(item.connections.map((c) => (c.cli === 'claude' ? 'Claude Code' : 'Codex')))].join(' and ')}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                      </span>
                    </span>
                  </button>
                  <span className="plugins-row-actions">
                    {item.updateAvailable && listing && (
                      <button className="secondary-button plugins-small-button" disabled={!!rowProps.working} onClick={() => rowProps.onInstall(listing)}>
                        Update
                      </button>
                    )}
                    <Switch checked={item.enabled} label={`${item.enabled ? 'Disable' : 'Enable'} ${name}`} onChange={(value) => rowProps.onToggle(item, value)} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {own.map((market) => {
        const entries = catalog.plugins.filter((entry) => entry.marketplace === market.name);
        return (
          <Section key={market.name} title={`From ${market.name}`} count={entries.length}>
            {market.error ? (
              <p className="tool-error" role="alert">
                {market.error}
              </p>
            ) : (
              <ul className="plugins-grid" aria-label={`From ${market.name}`}>
                {entries.map((entry) => (
                  <CatalogRow key={entry.id} entry={entry} {...rowProps} />
                ))}
              </ul>
            )}
          </Section>
        );
      })}
      {!own.length && (
        <p className="plugins-note">
          Have your own catalog?{' '}
          <button className="text-button plugins-inline-link" onClick={onSettings}>
            Add a marketplace
          </button>{' '}
          from a Git repository or folder.
        </p>
      )}
    </>
  );
}

function GitInstall({ busy, onBack, onReview }: { busy: boolean; onBack(): void; onReview(url: string, ref: string): void }) {
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  return (
    <div className="plugins-details">
      <button className="text-button plugins-back" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </button>
      <h3 className="plugins-consent-title">Install from a Git address</h3>
      <p className="muted">Veyo clones the repository, shows you everything the plugin contains, and installs it only if you agree.</p>
      <form
        className="plugins-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim()) onReview(url.trim(), ref.trim());
        }}
      >
        <label className="field-label">
          Git address
          <input className="text-input" data-autofocus value={url} placeholder="https://github.com/owner/plugin.git" spellCheck={false} onChange={(event) => setUrl(event.target.value)} />
        </label>
        <label className="field-label plugins-ref">
          Branch or tag (optional)
          <input className="text-input" value={ref} spellCheck={false} onChange={(event) => setRef(event.target.value)} />
        </label>
        <button className="primary-button" disabled={busy || !url.trim()}>
          {busy ? <><Spinner /> Cloning…</> : 'Review'}
        </button>
      </form>
    </div>
  );
}

function Marketplaces({ catalog, loadError, onBack, onToast }: { catalog: PluginCatalog | null; loadError: string; onBack(): void; onToast: Toast }) {
  const api = window.workspace!;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState('');
  async function act(label: string, work: () => Promise<unknown>, success: string) {
    setBusy(label);
    setError('');
    try {
      await work();
      onToast(success);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="plugins-details">
      <button className="text-button plugins-back" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </button>
      <h3 className="plugins-consent-title">Marketplaces</h3>
      <p className="muted">The Veyo catalog is built in. Add your own from a Git repository or a folder; nothing is installed until you choose a plugin.</p>
      <form
        className="plugins-inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const value = input.trim();
          if (value && (await act('add', () => api.pluginsAddMarketplace(value), 'Marketplace added'))) setInput('');
        }}
      >
        <label className="field-label plugins-grow">
          Add a marketplace
          <input className="text-input" data-autofocus value={input} placeholder="owner/repo, https://… Git address, or a folder path" spellCheck={false} onChange={(event) => setInput(event.target.value)} />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={!!busy}
          onClick={async () => {
            const folder = await api.pluginsPickFolder().catch(() => null);
            if (folder) setInput(folder);
          }}
        >
          <FolderOpen size={14} /> Browse…
        </button>
        <button className="primary-button" disabled={!!busy || !input.trim()}>
          {busy === 'add' ? <><Spinner /> Adding…</> : 'Add'}
        </button>
      </form>
      {catalog && !catalog.gitAvailable && <p className="plugins-note">Git is not installed, so only folder marketplaces can be added.</p>}
      {error && (
        <p className="tool-error" role="alert">
          <AlertCircle size={14} /> {error}
        </p>
      )}
      {loadError ? (
        <p className="tool-error" role="alert">
          {loadError}
        </p>
      ) : !catalog ? (
        <Loading label="Loading marketplaces…" />
      ) : (
        <ul className="plugins-list" aria-label="Marketplaces">
          {catalog.marketplaces.map((market) => (
            <li key={market.name} className="plugins-row">
              <div className="plugins-row-main plugins-row-static">
                <span className="plugins-row-title">
                  <strong>{market.name}</strong>
                  {market.builtin && <span className="plugins-badge plugins-badge-accent">Built in</span>}
                  <span className="plugins-badge">{market.source.kind === 'git' ? 'Git' : 'Folder'}</span>
                  {market.error && <span className="plugins-badge plugins-badge-error">Unreadable</span>}
                </span>
                <span className="plugins-row-description plugins-mono">{marketplaceSourceLabel(market.source)}</span>
                <span className="plugins-row-meta">
                  {market.error ||
                    [
                      market.owner && `by ${market.owner}`,
                      `${market.count} ${market.count === 1 ? 'plugin' : 'plugins'}`,
                      `updated ${updatedLabel(market.lastUpdated || market.addedAt)}`,
                      market.sha && `commit ${shortSha(market.sha)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                </span>
              </div>
              <span className="plugins-row-actions">
                {removing === market.name ? (
                  <>
                    <button className="secondary-button plugins-small-button" autoFocus onClick={() => setRemoving('')}>
                      Keep
                    </button>
                    <button
                      className="danger-button plugins-small-button"
                      disabled={!!busy}
                      onClick={async () => {
                        await act(`remove:${market.name}`, () => api.pluginsRemoveMarketplace(market.name), `Removed ${market.name}`);
                        setRemoving('');
                      }}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="icon-button"
                      disabled={!!busy}
                      aria-label={`Refresh ${market.name}`}
                      title="Refresh"
                      onClick={() => act(`refresh:${market.name}`, () => api.pluginsRefreshMarketplace(market.name), `Refreshed ${market.name}`)}
                    >
                      {busy === `refresh:${market.name}` ? <Spinner /> : <RefreshCw size={14} />}
                    </button>
                    {!market.builtin && (
                      <button className="icon-button" disabled={!!busy} aria-label={`Remove ${market.name}`} title="Remove (installed plugins stay)" onClick={() => setRemoving(market.name)}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The lists shared by the review and details views: every command line is spelled out. */
function Contributions({ plugin, mcp }: { plugin: PluginDetail; mcp?: ReactNode }) {
  const c = plugin.contributes;
  const sections: { title: string; warn?: boolean; items?: ReactNode[]; content?: ReactNode }[] = [
    {
      title: 'Commands it can run',
      warn: true,
      items: c.commands.map((item) => (
        <li key={item.id}>
          <strong>{item.title}</strong>
          <code>{commandLine(item.run.program, item.run.args)}</code>
          {item.description && <small>{item.description}</small>}
        </li>
      )),
    },
    {
      title: 'Agent presets',
      warn: true,
      items: c.agents.map((item) => (
        <li key={item.id}>
          <strong>{item.label}</strong>
          <code>{commandLine(item.program, item.args)}</code>
        </li>
      )),
    },
    mcp
      ? { title: 'MCP servers', warn: true, content: mcp }
      : {
          title: 'MCP servers',
          warn: true,
          items: c.mcpServers.map((server) => (
            <li key={server.name}>
              <strong>{server.name}</strong>
              <code>{server.type === 'stdio' ? commandLine(server.command, server.args) : `${server.type.toUpperCase()} ${server.url}`}</code>
              {server.type === 'stdio' && server.env && <small>Sets {Object.keys(server.env).join(', ')}</small>}
            </li>
          )),
        },
    {
      title: 'Prompts and skills',
      items: [...c.prompts, ...c.skills].map((item) => (
        <li key={item.id}>
          <strong>{item.title}</strong>
          {item.description && <small>{item.description}</small>}
        </li>
      )),
    },
    {
      title: 'Themes',
      items: c.themes.map((item) => (
        <li key={item.id} className="plugins-theme-item">
          <span className="plugins-swatch" style={{ background: item.colors.chrome, borderColor: item.colors.accent }} aria-hidden="true" />
          <strong>{item.label}</strong>
        </li>
      )),
    },
  ];
  const shown = sections.filter((section) => (section.content && c.mcpServers.length) || section.items?.length);
  return (
    <div className="plugins-contributions">
      {!shown.length && <p className="muted">This plugin adds nothing Veyo can use.</p>}
      {shown.map((section) => (
        <section key={section.title} aria-label={section.title}>
          <h3>
            {section.warn && <ShieldAlert size={13} aria-hidden="true" />}
            {section.title}
          </h3>
          {section.content ?? <ul>{section.items}</ul>}
        </section>
      ))}
      {!!plugin.unsupported.length && <p className="plugins-note">Not used by Veyo: {plugin.unsupported.join(', ')}. These parts stay inactive.</p>}
    </div>
  );
}

function PluginHeading({ preview, entry, verb }: { preview: PluginPreview; entry?: PluginCatalogEntry; verb: string }) {
  const name = entry?.displayName || preview.plugin.name;
  return (
    <div className="plugins-heading">
      <PluginIcon name={name} icon={entry?.icon} iconDark={entry?.iconDark} size={44} />
      <div>
        <h3 className="plugins-consent-title">
          {verb} {name}
          <span className="plugins-version">{preview.plugin.version}</span>
        </h3>
        <p className="plugins-heading-meta">
          {[entry?.provider && `by ${entry.provider}`, entry?.provider && entry.marketplace !== 'local' && entry.marketplace !== 'git' && `listed in ${entry.marketplace}`]
            .filter(Boolean)
            .join(' · ') || preview.source}
        </p>
      </div>
    </div>
  );
}

/*
 * Choosing coding CLIs for each MCP server: the exact command per CLI, an OAuth
 * client ID when the server needs one, and whether a token variable is set.
 */
function McpChoices({
  pluginKey,
  scope,
  servers,
  projectId,
  selected,
  onSelected,
  clientId,
  onClientId,
  connections = [],
}: {
  /** An installed plugin's key, or "preview:<id>" for one under review. */
  pluginKey: string | null;
  scope?: 'user' | 'project';
  servers: McpServer[];
  projectId: string | null;
  selected: Record<string, boolean>;
  onSelected(next: Record<string, boolean>): void;
  clientId: string;
  onClientId(value: string): void;
  connections?: McpConnection[];
}) {
  const api = window.workspace!;
  const [plans, setPlans] = useState<Record<string, McpPlan>>({});
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!pluginKey || !projectId) return;
    let canceled = false;
    const timer = setTimeout(() => {
      Promise.all(
        servers.flatMap((server) =>
          CLIS.map((cli) =>
            api.pluginsMcpPlan(projectId, pluginKey, server.name, cli, { clientId, scope }).then(
              (plan) => [`${server.name}:${cli}`, plan] as const,
              (reason) => [`${server.name}:${cli}`, { cli, label: cli === 'claude' ? 'Claude Code' : 'Codex', available: false, auth: null, unsupported: errorMessage(reason) } as McpPlan] as const,
            ),
          ),
        ),
      )
        .then((list) => {
          if (canceled) return;
          const next = Object.fromEntries(list);
          setPlans(next);
          setProblem('');
          // Start with every CLI that can add the server, unless already chosen.
          const defaults: Record<string, boolean> = {};
          for (const [key, plan] of list) defaults[key] = selected[key] ?? (!!plan.available && !plan.unsupported && !connections.some((c) => `${c.server}:${c.cli}` === key));
          onSelected(defaults);
        })
        .catch((reason) => !canceled && setProblem(errorMessage(reason)));
    }, 200);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [api, pluginKey, projectId, clientId, scope, servers.map((server) => server.name).join('|')]);
  if (!projectId) return <p className="plugins-note">Open a project to add MCP servers: the coding CLI runs in a terminal there.</p>;
  if (!pluginKey) return null;
  const clientAuth = oauthClientAuth(servers);
  return (
    <div className="plugins-mcp">
      {problem && <p className="tool-error">{problem}</p>}
      {clientAuth && <OAuthClientSetup auth={clientAuth} clientId={clientId} onClientId={onClientId} />}
      {servers.map((server) => (
        <div key={server.name} className="plugins-mcp-server">
          <strong>{server.name}</strong>
          <code className="plugins-mcp-url">{server.type === 'stdio' ? commandLine(server.command, server.args) : server.url}</code>
          {CLIS.map((cli) => {
            const key = `${server.name}:${cli}`;
            const plan = plans[key];
            const connected = connections.find((c) => c.server === server.name && c.cli === cli);
            const disabled = !plan || !plan.available || !!plan.unsupported;
            return (
              <div key={cli} className="plugins-mcp-cli">
                <label>
                  <input type="checkbox" checked={!!selected[key] && !disabled} disabled={disabled} onChange={(event) => onSelected({ ...selected, [key]: event.target.checked })} />
                  Add to {cli === 'claude' ? 'Claude Code' : 'Codex'}
                  {connected && <span className="plugins-badge plugins-badge-accent">Added</span>}
                </label>
                {!plan ? (
                  <small>Checking…</small>
                ) : plan.unsupported ? (
                  <small>{plan.unsupported}</small>
                ) : !plan.available ? (
                  <small>{plan.label} is not installed on PATH.</small>
                ) : (
                  <>
                    <code>{plan.commandLine ? commandLine(plan.commandLine[0], plan.commandLine.slice(1)) : ''}</code>
                    <small>{plan.note}</small>
                  </>
                )}
              </div>
            );
          })}
          <McpAuthNote server={server} plan={plans[`${server.name}:claude`] || plans[`${server.name}:codex`]} />
        </div>
      ))}
    </div>
  );
}
type OAuthClient = Extract<McpAuth, { type: 'oauth-client' }>;
/** The OAuth client a server needs from the person, if any. */
function oauthClientAuth(servers: McpServer[]): OAuthClient | null {
  for (const server of servers) if (server.type !== 'stdio' && server.auth?.type === 'oauth-client') return server.auth;
  return null;
}
function OAuthClientSetup({ auth, clientId, onClientId }: { auth: OAuthClient; clientId: string; onClientId(value: string): void }) {
  const api = window.workspace!;
  return (
    <div className="plugins-mcp-setup">
      <p>
        This server needs an OAuth client from your own Google Cloud project. Create one of type <strong>Web application</strong> with the redirect URI{' '}
        <code>http://localhost:{auth.callbackPort}/callback</code>, then paste its client ID.{' '}
        <a
          href={auth.setupUrl}
          onClick={(event) => {
            event.preventDefault();
            api.openExternal(auth.setupUrl).catch(() => {});
          }}
        >
          Setup guide <ExternalLink size={11} />
        </a>
      </p>
      <label className="field-label">
        OAuth client ID
        <input className="text-input" data-autofocus value={clientId} spellCheck={false} placeholder={auth.clientIdHint || 'Client ID'} onChange={(event) => onClientId(event.target.value)} />
      </label>
      <p className="plugins-note">The client secret is entered in the Claude Code terminal; Veyo never sees it.</p>
    </div>
  );
}
function McpAuthNote({ server, plan }: { server: McpServer; plan?: McpPlan }) {
  const api = window.workspace!;
  if (server.type === 'stdio' || !server.auth) return null;
  if (server.auth.type === 'oauth')
    return (
      <p className="plugins-note">
        No token needed: you approve access in your browser. Codex opens the sign-in as soon as it adds the server; for Claude Code, choose <strong>Sign in</strong> in the plugin's details afterwards.
      </p>
    );
  if (server.auth.type === 'oauth-client') return <p className="plugins-note">After it is added, choose <strong>Sign in</strong> in the plugin's details.</p>;
  const auth = server.auth;
  const status = plan?.variable;
  return (
    <p className={`plugins-note${status?.inApp ? ' plugins-note-ok' : ''}`}>
      {status?.inApp ? <Check size={13} /> : <AlertCircle size={13} />}
      <span>
        {status?.inApp
          ? `${auth.variable} is set. The coding CLI reads your ${auth.label || 'token'} from it when it connects.`
          : status?.saved
            ? `${auth.variable} is saved for your account, but Veyo started before it was set. Restart Veyo so its terminals can see it.`
            : `Set ${auth.variable} to your ${auth.label || 'token'} before using the server (for example with setx ${auth.variable} "<token>"), then restart Veyo. `}
        {!status?.inApp && auth.url && (
          <a
            href={auth.url}
            onClick={(event) => {
              event.preventDefault();
              api.openExternal(auth.url).catch(() => {});
            }}
          >
            Create a token <ExternalLink size={11} />
          </a>
        )}
      </span>
    </p>
  );
}

/*
 * The compact sheet for plugins that can run something: what it runs, where to
 * add its MCP servers, and one Install button. The full review is one click away.
 */
function InstallSheet({
  preview,
  entry,
  projectId,
  projectName,
  workspaceName,
  onCancel,
  onFullReview,
  onDone,
}: {
  preview: PluginPreview;
  entry?: PluginCatalogEntry;
  projectId: string | null;
  projectName?: string;
  workspaceName?: string;
  onCancel(): void;
  onFullReview(): void;
  onDone(message: string, terminals: TerminalInfo[]): void;
}) {
  const api = window.workspace!;
  const plugin = preview.plugin;
  const c = plugin.contributes;
  const existing = preview.installed.find((item) => item.scope === 'user') ?? preview.installed.find((item) => item.projectId === projectId);
  const [scope, setScope] = useState<'user' | 'project'>(existing?.scope ?? 'user');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isUpdate = preview.installed.some((item) => item.scope === scope && (scope === 'user' || item.projectId === projectId));
  const needsClient = c.mcpServers.some((server) => server.type !== 'stdio' && server.auth?.type === 'oauth-client');
  const chosen = Object.entries(selected).filter(([, on]) => on);
  async function install() {
    setBusy(true);
    setError('');
    try {
      if (needsClient && chosen.length && !clientId.trim()) throw new Error('Paste the OAuth client ID first, or untick the coding CLIs to install without adding the server.');
      const result = await api.pluginsInstall(preview.previewId, scope, scope === 'project' ? projectId ?? undefined : undefined);
      const terminals: TerminalInfo[] = [];
      for (const [key] of chosen) {
        const [server, cli] = key.split(':') as [string, McpCli];
        terminals.push(await api.pluginsMcpAdd(projectId!, result.key, server, cli, { clientId: clientId.trim() }, workspaceName));
      }
      const name = entry?.displayName || plugin.name;
      onDone(
        terminals.length
          ? `${isUpdate ? 'Updated' : 'Installed'} ${name}. Adding it in ${terminals.length === 1 ? 'a terminal' : `${terminals.length} terminals`}.`
          : `${isUpdate ? 'Updated' : 'Installed'} ${name}`,
        terminals,
      );
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }
  return (
    <div className="plugins-consent" aria-label={`Install ${plugin.name}`}>
      <button className="text-button plugins-back" onClick={onCancel} disabled={busy}>
        <ArrowLeft size={14} /> Back
      </button>
      <PluginHeading preview={preview} entry={entry} verb={isUpdate ? 'Update' : 'Install'} />
      {preview.update && isUpdate && (
        <ul className="plugins-update-lines" aria-label="What changes">
          {describeUpdate(preview.update).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {!!c.commands.length && (
        <section className="plugins-sheet-section" aria-label="Commands it can run">
          <h3>
            <ShieldAlert size={13} aria-hidden="true" /> Commands it can run
          </h3>
          <ul>
            {c.commands.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong> <code>{commandLine(item.run.program, item.run.args)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!c.agents.length && (
        <section className="plugins-sheet-section" aria-label="Agent presets">
          <h3>
            <ShieldAlert size={13} aria-hidden="true" /> Agent presets
          </h3>
          <ul>
            {c.agents.map((item) => (
              <li key={item.id}>
                <strong>{item.label}</strong> <code>{commandLine(item.program, item.args)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!c.mcpServers.length && (
        <section className="plugins-sheet-section" aria-label="MCP servers">
          <h3>
            <ShieldAlert size={13} aria-hidden="true" /> MCP servers
          </h3>
          <McpChoices
            pluginKey={existing?.key ?? `preview:${preview.previewId}`}
            scope={scope}
            servers={c.mcpServers}
            projectId={projectId}
            selected={selected}
            onSelected={setSelected}
            clientId={clientId}
            onClientId={setClientId}
          />
        </section>
      )}
      <fieldset className="plugins-scope">
        <legend>Use it in</legend>
        <label>
          <input type="radio" name="plugin-scope" checked={scope === 'user'} onChange={() => setScope('user')} />
          All projects
        </label>
        <label>
          <input type="radio" name="plugin-scope" checked={scope === 'project'} disabled={!projectId} onChange={() => setScope('project')} />
          {projectName ? `Only ${projectName}` : 'This project (open a project first)'}
        </label>
      </fieldset>
      {error && (
        <p className="tool-error" role="alert">
          <AlertCircle size={14} /> {error}
        </p>
      )}
      <div className="tool-actions">
        <button className="primary-button" data-autofocus={needsClient ? undefined : true} onClick={install} disabled={busy}>
          {busy ? 'Installing…' : isUpdate ? 'Update' : 'Install'}
        </button>
        <button className="secondary-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="text-button plugins-confirm-copy" onClick={onFullReview} disabled={busy}>
          Full details
        </button>
      </div>
    </div>
  );
}

function Consent({
  preview,
  entry,
  projectId,
  projectName,
  onCancel,
  onInstalled,
}: {
  preview: PluginPreview;
  entry?: PluginCatalogEntry;
  projectId: string | null;
  projectName?: string;
  onCancel(): void;
  onInstalled(message: string): void;
}) {
  const api = window.workspace!;
  const plugin = preview.plugin;
  const existing = preview.installed.find((item) => item.scope === 'user') ?? preview.installed.find((item) => item.projectId === projectId);
  const [scope, setScope] = useState<'user' | 'project'>(existing?.scope ?? 'user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blocked = preview.conflict || (!plugin.compatible ? `This plugin needs Veyo ${plugin.minAppVersion} or later.` : '');
  const isUpdate = preview.installed.some((item) => item.scope === scope && (scope === 'user' || item.projectId === projectId));
  async function install() {
    setBusy(true);
    setError('');
    try {
      await api.pluginsInstall(preview.previewId, scope, scope === 'project' ? projectId ?? undefined : undefined);
      onInstalled(`${isUpdate ? 'Updated' : 'Installed'} ${entry?.displayName || plugin.name} ${plugin.version}`);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }
  return (
    <div className="plugins-consent" aria-label={`Review ${plugin.name}`}>
      <button className="text-button plugins-back" onClick={onCancel} disabled={busy}>
        <ArrowLeft size={14} /> Back
      </button>
      <PluginHeading preview={preview} entry={entry} verb={isUpdate ? 'Update' : 'Install'} />
      <p className="muted">
        Review what this plugin adds. Installing copies its files and runs nothing. Its commands run only when you choose them, in a terminal you can see.
      </p>
      <dl className="plugins-facts">
        <dt>Source</dt>
        <dd className="plugins-mono">{preview.source}</dd>
        {preview.sha && (
          <>
            <dt>Commit</dt>
            <dd className="plugins-mono" title={preview.sha}>
              {preview.sha}
            </dd>
          </>
        )}
        {plugin.manifestName && (
          <>
            <dt>Calls itself</dt>
            <dd>
              {plugin.manifestName} (listed as {plugin.name}, which Veyo uses)
            </dd>
          </>
        )}
        <dt>Author</dt>
        <dd>{plugin.author?.name || 'Not stated'}</dd>
        {plugin.license && (
          <>
            <dt>License</dt>
            <dd>{plugin.license}</dd>
          </>
        )}
        {plugin.homepage && (
          <>
            <dt>Homepage</dt>
            <dd className="plugins-mono">{plugin.homepage}</dd>
          </>
        )}
        {plugin.description && (
          <>
            <dt>Description</dt>
            <dd>{plugin.description}</dd>
          </>
        )}
      </dl>
      {preview.update && isUpdate && (
        <section className="plugins-update" aria-label="What changes">
          <h3>What changes</h3>
          <ul>
            {describeUpdate(preview.update).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      <Contributions plugin={plugin} />
      {plugin.readme && <Readme content={plugin.readme} onError={(reason) => setError(errorMessage(reason))} />}
      <fieldset className="plugins-scope">
        <legend>Use it in</legend>
        <label>
          <input type="radio" name="plugin-scope" checked={scope === 'user'} onChange={() => setScope('user')} />
          All projects
        </label>
        <label>
          <input type="radio" name="plugin-scope" checked={scope === 'project'} disabled={!projectId} onChange={() => setScope('project')} />
          {projectName ? `Only ${projectName}` : 'This project (open a project first)'}
        </label>
      </fieldset>
      {(blocked || error) && (
        <p className="tool-error" role="alert">
          <AlertCircle size={14} /> {blocked || error}
        </p>
      )}
      <div className="tool-actions">
        <button className="primary-button" onClick={install} disabled={busy || !!blocked}>
          {busy ? 'Installing…' : isUpdate ? 'Update plugin' : 'Install plugin'}
        </button>
        <button className="secondary-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Readme({ content, onError }: { content: string; onError(reason: unknown): void }) {
  return (
    <section className="plugins-readme" aria-label="README">
      <h3>README</h3>
      <div className="plugins-readme-body">
        <MarkdownMessage content={content} onError={onError} />
      </div>
    </section>
  );
}

function Details({
  entry,
  listing,
  projectId,
  projectName,
  workspaceName,
  working,
  onBack,
  onToast,
  onUpdate,
  onTerminal,
}: {
  entry: InstalledPlugin | undefined;
  listing?: PluginCatalogEntry;
  projectId: string | null;
  projectName?: string;
  workspaceName?: string;
  working: string;
  onBack(): void;
  onToast: Toast;
  onUpdate(entry: InstalledPlugin): void;
  onTerminal(info: TerminalInfo[]): void;
}) {
  const api = window.workspace!;
  const [detail, setDetail] = useState<{ plugin?: PluginDetail; error?: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removeConnections, setRemoveConnections] = useState(true);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!entry) return;
    let canceled = false;
    api
      .pluginsDetails(entry.key)
      .then((value) => !canceled && setDetail(value))
      .catch((reason) => !canceled && setDetail({ error: errorMessage(reason) }));
    return () => {
      canceled = true;
    };
  }, [api, entry?.key, entry?.lastUpdated]);
  if (!entry)
    return (
      <div className="plugins-details">
        <button className="text-button plugins-back" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>
        <p className="muted">This plugin is no longer installed.</p>
      </div>
    );
  const name = listing?.displayName || entry.name;
  const servers = detail?.plugin?.contributes.mcpServers || [];
  const chosen = Object.entries(selected).filter(([key, on]) => on && !entry.connections.some((c) => `${c.server}:${c.cli}` === key));
  async function run(work: () => Promise<TerminalInfo[]>, message: string) {
    setBusy(true);
    setError('');
    try {
      const terminals = await work();
      onToast(message);
      if (terminals.length) onTerminal(terminals);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  async function uninstall() {
    setBusy(true);
    setError('');
    try {
      const terminals: TerminalInfo[] = [];
      // Removal terminals start before the install record goes away.
      if (removeConnections && projectId)
        for (const connection of entry!.connections) terminals.push(await api.pluginsMcpRemove(projectId, entry!.key, connection.cli, connection.name, workspaceName));
      await api.pluginsUninstall(entry!.key);
      onToast(`Uninstalled ${name}`);
      if (terminals.length) onTerminal(terminals);
      else onBack();
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  }
  const signIn = servers.filter((server) => server.type !== 'stdio' && (server.auth?.type === 'oauth' || server.auth?.type === 'oauth-client'));
  return (
    <div className="plugins-details">
      <button className="text-button plugins-back" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </button>
      <div className="plugins-heading">
        <PluginIcon name={name} icon={listing?.icon} iconDark={listing?.iconDark} size={44} />
        <div>
          <h3 className="plugins-consent-title">
            {name} <span className="plugins-version">{entry.version}</span>
            {entry.updateAvailable && <span className="plugins-badge plugins-badge-accent">Update available</span>}
          </h3>
          <p className="plugins-heading-meta">{[listing?.provider && `by ${listing.provider}`, detail?.plugin?.description].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <dl className="plugins-facts">
        <dt>Source</dt>
        <dd className="plugins-mono">{sourceLabel(entry)}</dd>
        {entry.sha && (
          <>
            <dt>Commit</dt>
            <dd className="plugins-mono" title={entry.sha}>
              {entry.sha}
            </dd>
          </>
        )}
        <dt>Used in</dt>
        <dd>{scopeLabel(entry.scope, entry.scope === 'project' ? projectName : undefined)}</dd>
        <dt>Status</dt>
        <dd>
          <span className="plugins-inline-switch">
            <Switch checked={entry.enabled} label={`${entry.enabled ? 'Disable' : 'Enable'} ${name}`} onChange={(value) => api.pluginsSetEnabled(entry.key, value).catch((reason) => setError(errorMessage(reason)))} />
            {entry.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </dd>
        <dt>Installed</dt>
        <dd>
          {updatedLabel(entry.installedAt)}
          {entry.lastUpdated !== entry.installedAt ? ` · updated ${updatedLabel(entry.lastUpdated)}` : ''}
        </dd>
        {!!entry.connections.length && (
          <>
            <dt>Added to</dt>
            <dd>{entry.connections.map((c) => `${c.cli === 'claude' ? 'Claude Code' : 'Codex'} (${c.name})`).join(', ')}</dd>
          </>
        )}
      </dl>
      {(detail?.error || entry.error) && (
        <p className="tool-error" role="alert">
          <AlertCircle size={14} /> {detail?.error || entry.error}
        </p>
      )}
      {!detail && <Loading label="Loading…" />}
      {detail?.plugin && (
        <Contributions
          plugin={detail.plugin}
          mcp={
            servers.length ? (
              entry.enabled ? (
                <>
                  <McpChoices
                    pluginKey={entry.key}
                    servers={servers}
                    projectId={projectId}
                    selected={selected}
                    onSelected={setSelected}
                    clientId={clientId}
                    onClientId={setClientId}
                    connections={entry.connections}
                  />
                  <div className="plugins-mcp-actions">
                    <button
                      className="secondary-button plugins-small-button"
                      disabled={busy || !projectId || !chosen.length}
                      onClick={() =>
                        run(
                          () => Promise.all(chosen.map(([key]) => {
                            const [server, cli] = key.split(':') as [string, McpCli];
                            return api.pluginsMcpAdd(projectId!, entry.key, server, cli, { clientId: clientId.trim() }, workspaceName);
                          })),
                          `Adding ${name} in a terminal`,
                        )
                      }
                    >
                      <SquareTerminal size={13} /> Add selected
                    </button>
                    {signIn.flatMap((server) =>
                      entry.connections
                        .filter((c) => c.server === server.name)
                        .map((c) => (
                          <button
                            key={`${server.name}:${c.cli}`}
                            className="secondary-button plugins-small-button"
                            disabled={busy || !projectId}
                            onClick={() => run(async () => [await api.pluginsMcpLogin(projectId!, entry.key, server.name, c.cli, workspaceName)], `Signing in to ${c.name}`)}
                          >
                            Sign in with {c.cli === 'claude' ? 'Claude Code' : 'Codex'}
                          </button>
                        )),
                    )}
                  </div>
                </>
              ) : (
                <p className="plugins-note">Enable the plugin to add its MCP servers.</p>
              )
            ) : undefined
          }
        />
      )}
      {detail?.plugin?.readme && <Readme content={detail.plugin.readme} onError={(reason) => setError(errorMessage(reason))} />}
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      <div className="tool-actions">
        {confirming ? (
          <>
            <button className="danger-button" onClick={uninstall} disabled={busy}>
              {busy ? 'Removing…' : 'Uninstall'}
            </button>
            <button className="secondary-button" autoFocus onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <span className="plugins-confirm-copy">
              Remove {name} and its files?
              {!!entry.connections.length && (
                <label className="plugins-confirm-option">
                  <input type="checkbox" checked={removeConnections} disabled={!projectId} onChange={(event) => setRemoveConnections(event.target.checked)} />
                  Also remove its MCP servers from {[...new Set(entry.connections.map((c) => (c.cli === 'claude' ? 'Claude Code' : 'Codex')))].join(' and ')}
                </label>
              )}
            </span>
          </>
        ) : (
          <>
            <button className="danger-button" onClick={() => setConfirming(true)}>
              <Trash2 size={14} /> Uninstall…
            </button>
            <button className="secondary-button" disabled={!!working} onClick={() => onUpdate(entry)}>
              {working ? <Spinner /> : <RefreshCw size={14} />}
              {entry.updateAvailable ? 'Update…' : 'Check for update'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
