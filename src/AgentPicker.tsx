import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Bookmark,
  CornerDownLeft,
  Folder,
  GitBranch,
  History,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import type { AgentOption, AgentSelection } from './types';
import BrandLogo from './AgentLogo';

type SavedPreset = { id: string; name: string; selections: AgentSelection[] };
const storageKey = 'agent-lineup-presets:v1';
function readPresets(): SavedPreset[] {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(data)
      ? data.filter(
          (p) =>
            p &&
            typeof p.id === 'string' &&
            typeof p.name === 'string' &&
            Array.isArray(p.selections) &&
            p.selections.length &&
            p.selections.every(
              (s: AgentSelection) =>
                s && typeof s.agentId === 'string' && Number.isSafeInteger(s.count) && s.count > 0,
            ),
        )
      : [];
  } catch {
    return [];
  }
}

function clampCounts(
  counts: Record<string, number>,
  agents: AgentOption[],
  remaining: number,
): Record<string, number> {
  const installed = new Set(agents.filter((agent) => agent.installed).map((agent) => agent.id));
  let slots = Math.max(0, remaining);
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([agentId, count]) => installed.has(agentId) && count > 0)
      .map(([agentId, count]) => {
        const next = Math.min(count, slots);
        slots -= next;
        return [agentId, next] as const;
      })
      .filter(([, count]) => count > 0),
  );
}

function toSelections(counts: Record<string, number>): AgentSelection[] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([agentId, count]) => ({ agentId, count }));
}

/* Order-independent identity of a lineup, used to highlight the matching preset. */
function lineupKey(selections: AgentSelection[]) {
  return selections
    .filter(({ count }) => count > 0)
    .map(({ agentId, count }) => `${agentId}:${count}`)
    .sort()
    .join('|');
}

const shortLabel = (label: string) => label.replace(/\s+(Code|CLI|Agent)$/i, '');

/* Claude's spark: twelve rays of alternating length around an open centre. */
export function Spark({ size = 22, className = '' }: { size?: number; className?: string }) {
  const rays = Array.from({ length: 12 }, (_, index) => {
    const angle = (index * Math.PI) / 6 + 0.12;
    const outer = index % 2 ? 8.4 : 11;
    return (
      <line
        key={index}
        x1={12 + Math.cos(angle) * 2.4}
        y1={12 + Math.sin(angle) * 2.4}
        x2={12 + Math.cos(angle) * outer}
        y2={12 + Math.sin(angle) * outer}
      />
    );
  });
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {rays}
    </svg>
  );
}

const cleanError = (value: unknown) =>
  String(value).replace(/^Error: Error invoking remote method '[^']+': Error: /, '');

export default function AgentPicker({
  projectId,
  projectName,
  projectPath,
  workspaceName,
  gitAvailable,
  presetSelections = [],
  onSelect,
  onNotify,
}: {
  projectId: string;
  projectName: string;
  projectPath: string;
  workspaceName: string;
  gitAvailable: boolean;
  presetSelections?: AgentSelection[];
  onSelect(selections: AgentSelection[]): Promise<void> | void;
  onNotify?(text: string, action?: { label: string; run: () => void }): void;
}) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  const [savedPresets, setSavedPresets] = useState(readPresets);
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetError, setPresetError] = useState('');
  const [notice, setNotice] = useState<{ text: string; undo?: SavedPreset[] } | null>(null);
  // The preset the lineup was last loaded from, so saving after a tweak can update it.
  const [basePreset, setBasePreset] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const hasLoadedAgents = useRef(false);

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const installedAgents = agents.filter((agent) => agent.installed);
  const missingAgents = agents.filter((agent) => !agent.installed);
  const selectedAgents = installedAgents.filter((agent) => (counts[agent.id] || 0) > 0);
  const currentKey = lineupKey(toSelections(counts));
  const labelFor = (agentId: string) =>
    agents.find((agent) => agent.id === agentId)?.label || agentId;
  const describe = (selections: AgentSelection[]) =>
    selections
      .map(({ agentId, count }) => `${shortLabel(labelFor(agentId))} ×${count}`)
      .join(' · ');
  const seatsIn = (selections: AgentSelection[]) =>
    selections.reduce((sum, { count }) => sum + count, 0);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.undo ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (saving) nameInput.current?.focus();
  }, [saving]);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const result = await window.workspace!.listAgents(projectId, workspaceName);
      setAgents(result.agents);
      setRemaining(result.remaining);
      const useDefaultSelection = !hasLoadedAgents.current;
      hasLoadedAgents.current = true;
      setCounts((current) => {
        const next = clampCounts(current, result.agents, result.remaining);
        if (Object.keys(next).length || result.remaining < 1 || !useDefaultSelection) return next;
        const fallback =
          result.agents.find((agent) => agent.installed && agent.id !== 'terminal') ||
          result.agents.find((agent) => agent.installed);
        return fallback ? { [fallback.id]: 1 } : next;
      });
    } catch (value) {
      setError(cleanError(value));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Ctrl+Enter launches from anywhere on the page, like sending a prompt.
  const launchRef = useRef<() => void>(() => {});
  launchRef.current = launch;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Naming a preset owns Enter; launching from there would skip the save.
      if (event.target instanceof Element && event.target.closest('.home-save')) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        launchRef.current();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function launch(selections = toSelections(counts)) {
    const seats = seatsIn(selections);
    if (!seats || seats > remaining || launching) return;
    setLaunching(true);
    setError('');
    try {
      await onSelect(selections);
    } catch (value) {
      setError(cleanError(value));
    } finally {
      setLaunching(false);
    }
  }

  function setAgentCount(agentId: string, next: number) {
    if (launching || loading || !Number.isSafeInteger(next) || next < 0) return;
    setCounts((current) => {
      const otherTotal = Object.entries(current).reduce(
        (sum, [id, count]) => sum + (id === agentId ? 0 : count),
        0,
      );
      if (next > remaining - otherTotal) return current;
      const updated = { ...current };
      if (next) updated[agentId] = next;
      else delete updated[agentId];
      return updated;
    });
  }

  function toggleAgent(agent: AgentOption) {
    if (!agent.installed) return;
    setAgentCount(agent.id, counts[agent.id] ? 0 : 1);
  }

  function unavailableReason(selections: AgentSelection[]) {
    if (loading) return 'Checking installed agents…';
    const missing = selections.filter(
      (s) => !agents.some((a) => a.id === s.agentId && a.installed),
    );
    if (missing.length)
      return `Not installed: ${missing.map((s) => labelFor(s.agentId)).join(', ')}`;
    const seats = seatsIn(selections);
    return seats > remaining ? `Needs ${seats} sessions; only ${remaining} available` : '';
  }

  function applyPreset(selections: AgentSelection[], presetId: string | null = null) {
    if (launching || unavailableReason(selections)) return;
    setError('');
    setBasePreset(presetId);
    setCounts(
      clampCounts(
        Object.fromEntries(selections.map(({ agentId, count }) => [agentId, count])),
        agents,
        remaining,
      ),
    );
  }

  function launchPreset(selections: AgentSelection[], presetId: string | null = null) {
    if (launching || unavailableReason(selections)) return;
    applyPreset(selections, presetId);
    void launch(selections);
  }

  function persistPresets(next: SavedPreset[]) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSavedPresets(next);
      return true;
    } catch {
      setPresetError('Presets could not be saved on this device.');
      return false;
    }
  }

  function openSave() {
    // After tweaking a loaded preset, offer to update it; typing a new name saves a copy.
    setPresetName(savedPresets.find((p) => p.id === basePreset)?.name || '');
    setPresetError('');
    setSaving(true);
  }

  function closeSave() {
    setSaving(false);
    setPresetError('');
  }

  function savePreset(event: FormEvent) {
    event.preventDefault();
    const name = presetName.trim();
    if (!name || !total) return;
    const selections = toSelections(counts);
    const existing = savedPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      const previous = savedPresets;
      if (
        persistPresets(
          previous.map((p) => (p.id === existing.id ? { ...p, name, selections } : p)),
        )
      ) {
        setSaving(false);
        setBasePreset(existing.id);
        setNotice({ text: `Updated “${name}”`, undo: previous });
      }
      return;
    }
    const preset = { id: crypto.randomUUID(), name, selections };
    if (persistPresets([...savedPresets, preset])) {
      setSaving(false);
      setBasePreset(preset.id);
      setNotice({ text: `Saved “${name}”` });
    }
  }

  function deletePreset(preset: SavedPreset) {
    const previous = savedPresets;
    if (persistPresets(previous.filter((p) => p.id !== preset.id))) {
      const text = `Deleted “${preset.name}”`;
      const undo = { label: 'Undo', run: () => void persistPresets(previous) };
      if (onNotify) onNotify(text, undo);
      else setNotice({ text, undo: previous });
    }
  }

  const lastUsedReason = presetSelections.length ? unavailableReason(presetSelections) : '';
  const lastUsedIsSaved = savedPresets.some(
    (p) => lineupKey(p.selections) === lineupKey(presetSelections),
  );
  const showLastUsed = presetSelections.length > 0 && !lastUsedIsSaved;
  const currentPreset = total
    ? savedPresets.find((p) => lineupKey(p.selections) === currentKey)
    : undefined;
  const updating = savedPresets.some(
    (p) => p.name.toLowerCase() === presetName.trim().toLowerCase(),
  );

  function renderAgent(agent: AgentOption) {
    const count = counts[agent.id] || 0;
    const selected = count > 0;
    const canAdd = total < remaining;
    return (
      <div key={agent.id} className={`home-tile ${selected ? 'selected' : ''}`}>
        <button
          type="button"
          className="agent-picker-select home-tile-select"
          disabled={launching || loading || (!selected && !canAdd)}
          aria-pressed={selected}
          title={selected ? `Remove ${agent.label}` : `Add ${agent.label}`}
          onClick={() => toggleAgent(agent)}
        >
          <BrandLogo agentId={agent.id} size={16} className="home-tile-logo" />
          <span className="home-tile-name">{agent.label}</span>
        </button>
        {selected ? (
          <div className="home-stepper" role="group" aria-label={`${agent.label} sessions`}>
            <button
              type="button"
              aria-label={count === 1 ? `Remove ${agent.label}` : `Fewer ${agent.label} sessions`}
              disabled={launching}
              onClick={() => setAgentCount(agent.id, count - 1)}
            >
              <Minus size={12} />
            </button>
            <span aria-live="polite">{count}</span>
            <button
              type="button"
              aria-label={`More ${agent.label} sessions`}
              disabled={launching || !canAdd}
              onClick={() => setAgentCount(agent.id, count + 1)}
            >
              <Plus size={12} />
            </button>
          </div>
        ) : (
          <span className="home-tile-hint" aria-hidden="true">
            <Plus size={12} />
            Add
          </span>
        )}
      </div>
    );
  }

  function renderPreset(
    key: string,
    name: string,
    selections: AgentSelection[],
    icon: React.ReactNode,
    preset?: SavedPreset,
  ) {
    const reason = unavailableReason(selections);
    const active = total > 0 && lineupKey(selections) === currentKey;
    return (
      <div key={key} className={`home-preset ${active ? 'selected' : ''}`}>
        <button
          type="button"
          className="home-preset-select"
          disabled={launching || !!reason}
          title={reason || `Load ${name} into the lineup`}
          aria-pressed={active}
          onClick={() => applyPreset(selections, preset?.id ?? null)}
        >
          <strong>
            {icon}
            <span>{name}</span>
          </strong>
          <small>{describe(selections)}</small>
        </button>
        <button
          type="button"
          className="home-preset-launch"
          disabled={launching || !!reason}
          aria-label={`Launch ${name}`}
          title={reason || `Launch ${name} now`}
          onClick={() => launchPreset(selections, preset?.id ?? null)}
        >
          <Play size={12} />
        </button>
        {preset && (
          <button
            type="button"
            className="home-preset-delete"
            disabled={launching}
            aria-label={`Delete preset ${name}`}
            title="Delete preset"
            onClick={() => {
              if (basePreset === preset.id) setBasePreset(null);
              deletePreset(preset);
            }}
          >
            <X size={13} strokeWidth={2.25} />
          </button>
        )}
      </div>
    );
  }

  const hasPresets = showLastUsed || savedPresets.length > 0;
  // One cell per free session, like Claude's activity grid.
  const slots = Math.max(0, Math.min(remaining, 32));

  return (
    <div className="home">
      <div className="home-scroll">
        <main className="home-shell">
          <header className="home-greeting">
            <h1>
              <Spark className="home-spark" size={26} />
              <span>What’s up next in {projectName}?</span>
            </h1>
            <p>
              {workspaceName} workspace · pick your agents, then launch. Each session opens in its
              own terminal pane.
            </p>
          </header>

          {(hasPresets || notice) && (
            <section className="home-presets" aria-label="Quick start">
              <div className="home-presets-head">
                <h2>Quick start</h2>
                {notice && (
                  <span className="home-notice" role="status">
                    {notice.text}
                    {notice.undo && (
                      <button
                        type="button"
                        onClick={() => {
                          if (persistPresets(notice.undo!)) setNotice(null);
                        }}
                      >
                        Undo
                      </button>
                    )}
                  </span>
                )}
              </div>
              <div className="home-preset-list">
                {showLastUsed &&
                  renderPreset('last-used', 'Last used', presetSelections, <History size={13} />)}
                {savedPresets.map((preset) =>
                  renderPreset(
                    preset.id,
                    preset.name,
                    preset.selections,
                    <Bookmark size={13} />,
                    preset,
                  ),
                )}
              </div>
            </section>
          )}

          <section className="home-card" aria-label="Lineup">
            <div className="home-card-head">
              <h2 className="home-card-title">Agents</h2>
              <button
                type="button"
                className="home-refresh"
                disabled={loading || launching || total === 0}
                onClick={() => {
                  setCounts({});
                  setBasePreset(null);
                }}
                aria-label="Clear selected agents"
                title="Clear selected agents"
              >
                <X size={12} />
                Clear
              </button>
              <button
                type="button"
                className="home-refresh"
                disabled={loading || launching}
                onClick={refresh}
                title="Check for installed agents again"
              >
                <RefreshCw size={12} className={loading ? 'spinning' : ''} />
                {loading ? 'Checking…' : 'Refresh'}
              </button>
            </div>

            {loading && !agents.length ? (
              <div className="home-loading">
                <LoaderCircle size={16} className="spinning" />
                Finding installed coding agents…
              </div>
            ) : (
              <div className="home-tiles home-agent-tiles">{installedAgents.map(renderAgent)}</div>
            )}

            <div className="home-meter">
              <div
                className="home-meter-cells"
                role="img"
                aria-label={`${total} of ${remaining} free sessions used`}
              >
                {Array.from({ length: slots }, (_, index) => (
                  <i
                    key={index}
                    className={index < total ? 'on' : ''}
                    style={{
                      '--cell-light-percent': `${Math.round((1 - index / Math.max(slots - 1, 1)) * 100)}%`,
                    } as React.CSSProperties}
                  />
                ))}
              </div>
              <p>
                <strong>{total}</strong> of {remaining} free{' '}
                {remaining === 1 ? 'session' : 'sessions'}
                {missingAgents.length > 0 && (
                  <span
                    title={`Not installed: ${missingAgents.map((agent) => agent.label).join(', ')}`}
                  >
                    {' '}
                    · {missingAgents.length} more supported{' '}
                    {missingAgents.length === 1 ? 'agent' : 'agents'} not detected
                  </span>
                )}
              </p>
            </div>
          </section>

          {error && (
            <div className="home-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={refresh}>
                <RefreshCw size={12} /> Try again
              </button>
            </div>
          )}

          <footer className="home-launch">
            <div className="home-chips">
              <span className="home-chip home-chip-path" title={projectPath}>
                <Folder size={13} />
                <span>{projectPath}</span>
              </span>
              <div className="home-access" role="radiogroup" aria-label="Workspace access">
                <button
                  type="button"
                  role="radio"
                  aria-checked="true"
                  className="home-chip active"
                  title={
                    gitAvailable
                      ? 'Sessions share your current Git checkout.'
                      : 'Not a Git repository, so sessions share this folder.'
                  }
                >
                  <Folder size={13} />
                  Shared checkout
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked="false"
                  className="home-chip"
                  disabled
                  title="Worktree isolation is coming soon"
                >
                  <GitBranch size={13} />
                  New worktree
                  <small>Soon</small>
                </button>
              </div>
            </div>
            <div className="home-composer">
              {saving ? (
                <form
                  className="home-save"
                  onSubmit={savePreset}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      closeSave();
                    }
                  }}
                >
                  <Bookmark size={15} aria-hidden="true" />
                  <input
                    ref={nameInput}
                    maxLength={40}
                    value={presetName}
                    placeholder="Name this lineup, e.g. Review squad"
                    aria-label="Preset name"
                    aria-invalid={!!presetError}
                    onChange={(event) => {
                      setPresetName(event.target.value);
                      setPresetError('');
                    }}
                  />
                  <small>{describe(toSelections(counts))}</small>
                  <button type="button" className="home-save-cancel" onClick={closeSave}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="primary-button home-launch-button"
                    disabled={!presetName.trim() || !total}
                  >
                    {updating ? 'Update preset' : 'Save preset'}
                  </button>
                </form>
              ) : (
                <>
              <span className="home-composer-marks" aria-hidden="true">
                {selectedAgents.slice(0, 4).map((agent) => (
                  <BrandLogo key={agent.id} agentId={agent.id} size={16} />
                ))}
              </span>
              <span className={`home-composer-text ${selectedAgents.length ? '' : 'empty'}`}>
                {currentPreset && <strong>{currentPreset.name} · </strong>}
                {selectedAgents.length
                  ? `${describe(toSelections(counts))} · ${total} ${total === 1 ? 'session' : 'sessions'}`
                  : 'Pick at least one agent to launch'}
              </span>
              {total > 0 && !currentPreset && (
                <button
                  type="button"
                  className="primary-button home-save-open"
                  disabled={launching || loading}
                  title="Save this lineup to Quick start"
                  onClick={openSave}
                >
                  <Bookmark size={13} />
                  {savedPresets.some((p) => p.id === basePreset) ? 'Save changes' : 'Save as preset'}
                </button>
              )}
              <button
                type="button"
                className="primary-button home-launch-button"
                disabled={loading || launching || !total || remaining < total}
                onClick={() => void launch()}
              >
                {launching ? 'Launching…' : 'Launch workspace'}
                {launching ? (
                  <LoaderCircle size={14} className="spinning" />
                ) : (
                  <CornerDownLeft size={14} />
                )}
              </button>
                </>
              )}
            </div>
            {presetError && <p className="home-field-error">{presetError}</p>}
          </footer>
        </main>
      </div>
    </div>
  );
}
