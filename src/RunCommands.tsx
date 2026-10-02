import { useEffect, useState } from 'react';
import { Play, Trash2 } from 'lucide-react';
import Modal from './Modal';
import type { RunPreset as Preset } from './types';
function readLegacyPresets(key: string): Preset[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value)
      ? value.filter((p) => p && typeof p.name === 'string' && typeof p.command === 'string')
      : [];
  } catch {
    return [];
  }
}
export default function RunCommands({
  projectId,
  shells,
  onClose,
  onRun,
}: {
  projectId: string;
  shells: { id: string; label: string }[];
  onClose(): void;
  onRun(command: string, name: string, shell: string): Promise<void>;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [scripts, setScripts] = useState<Preset[]>([]);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [shell, setShell] = useState(shells[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let canceled = false;
    const legacyKey = `run-presets:${projectId}`;
    window
      .workspace!.getRunPresets(projectId)
      .then(async (saved) => {
        if (saved) {
          if (!canceled) setPresets(saved);
          return;
        }
        // Presets used to live in localStorage, which differs between the dev
        // server and the packaged app. Import them once.
        const legacy = readLegacyPresets(legacyKey);
        if (!legacy.length) return;
        await window.workspace!.saveRunPresets(projectId, legacy);
        try {
          localStorage.removeItem(legacyKey);
        } catch {}
        if (!canceled) setPresets(legacy);
      })
      .catch(() => {
        if (!canceled) setError('Unable to load command presets.');
      });
    return () => {
      canceled = true;
    };
  }, [projectId]);
  useEffect(() => {
    let canceled = false;
    window
      .workspace!.readFile(projectId, 'package.json')
      .then((file) => {
        const pkg = JSON.parse(file.content);
        if (!canceled && pkg.scripts && typeof pkg.scripts === 'object') {
          const manager =
            typeof pkg.packageManager === 'string' && /^(pnpm|yarn)@/.test(pkg.packageManager)
              ? pkg.packageManager.split('@')[0]
              : 'npm';
          setScripts(
            Object.keys(pkg.scripts)
              .filter((name) => /^[a-z0-9:_-]+$/i.test(name))
              .map((name) => ({ name, command: `${manager} run ${name}` })),
          );
        }
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [projectId]);
  async function save(next: Preset[]) {
    try {
      await window.workspace!.saveRunPresets(projectId, next);
      setPresets(next);
      setError('');
    } catch {
      setError('Unable to save command presets.');
    }
  }
  async function run() {
    if (busy || !command.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onRun(command.trim(), name.trim() || command.trim().slice(0, 50), shell);
      onClose();
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Run command"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="muted">
        Run a command in a new terminal in this project. Review it before running.
      </p>
      {[
        { title: 'Package scripts', items: scripts },
        { title: 'Saved commands', items: presets },
      ].map(
        (group) =>
          !!group.items.length && (
            <section className="run-group" key={group.title}>
              <h3>{group.title}</h3>
              {group.items.map((preset) => (
                <div className="run-preset" key={preset.name}>
                  <button
                    className="text-button"
                    onClick={() => {
                      setName(preset.name);
                      setCommand(preset.command);
                    }}
                  >
                    <span>
                      {preset.name}
                      <small>{preset.command}</small>
                    </span>
                  </button>
                  {group.title === 'Saved commands' && (
                    <button
                      className="icon-button"
                      aria-label={`Remove preset ${preset.name}`}
                      onClick={() => save(presets.filter((p) => p.name !== preset.name))}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </section>
          ),
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <label className="field-label">
          Name
          <input
            className="text-input"
            aria-label="Command name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field-label">
          Command
          <textarea
            aria-label="Command to run"
            value={command}
            maxLength={10000}
            rows={3}
            required
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <label className="field-label">
          Shell
          <select
            aria-label="Command shell"
            value={shell}
            onChange={(event) => setShell(event.target.value)}
          >
            {shells.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <div className="tool-actions">
          <button className="primary-button" disabled={busy || !command.trim()}>
            <Play size={14} />
            {busy ? 'Starting…' : 'Run in terminal'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !name.trim() || !command.trim()}
            onClick={() =>
              save([
                ...presets.filter((p) => p.name !== name.trim()),
                { name: name.trim(), command: command.trim() },
              ])
            }
          >
            Save preset
          </button>
        </div>
      </form>
    </Modal>
  );
}
