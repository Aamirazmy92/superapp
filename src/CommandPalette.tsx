import { useEffect, useState } from 'react';
import { Command, Search } from './icons';
import { Backdrop, MotionDialog } from './motion';

export type PaletteCommand = {
  label: string;
  hint: string;
  action: () => unknown;
  icon: React.ComponentType<{ size?: number }>;
  /** Unique id when labels can repeat, as plugin contributions can. */
  id?: string;
  /** The plugin that contributed this command, shown as "from <plugin>". */
  source?: string;
};

/** Mounted only while open, so each opening starts with an empty query. */
export default function CommandPalette({
  commands: allCommands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const commands = allCommands.filter((c) =>
    `${c.label} ${c.source ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => setIndex(0), [query]);
  const run = (command: PaletteCommand) => {
    onClose();
    command.action();
  };
  return (
    <Backdrop
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <MotionDialog smoothHeight className="command-modal" role="dialog" aria-label="Command palette">
        <div className="command-input">
          <Search size={18} />
          <input
            autoFocus
            placeholder="What would you like to do?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex(
                  (current) =>
                    (current + (e.key === 'ArrowDown' ? 1 : -1) + commands.length) %
                    Math.max(1, commands.length),
                );
              }
              if (e.key === 'Enter' && commands[index]) {
                // Otherwise the same keypress activates whatever the opened dialog focuses.
                e.preventDefault();
                run(commands[index]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-list">
          {commands.map((c, i) => (
            <button
              key={c.id ?? c.label}
              className={index === i ? 'command-selected' : ''}
              onClick={() => run(c)}
            >
              <c.icon size={16} />
              <span>{c.label}</span>
              {c.source && <small className="plugin-source">from {c.source}</small>}
              <kbd>{c.hint}</kbd>
            </button>
          ))}
          {!commands.length && <p className="muted inset">No matching commands.</p>}
        </div>
        <div className="command-footer">
          <Command size={12} />
          Your workspace, a few keystrokes away.
        </div>
      </MotionDialog>
    </Backdrop>
  );
}
