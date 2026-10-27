import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  Code2,
  SquareTerminal,
  Sparkles,
  Keyboard,
  Info,
  X,
  Check,
  RotateCcw,
  Search,
  Command,
  CornerDownLeft,
  SlidersHorizontal,
  MessageSquare,
  Bell,
  Zap,
  Download,
} from './icons';
import {
  defaults,
  fontFamilies,
  fontSizes,
  fontStack,
  usageCriticalLevels,
  usageWarningLevels,
  type Preferences,
} from './preferences';
import { themes, type ThemeName } from './themes';
import { matchesSearch } from './settingsSearch';
import { version } from '../package.json';
import './settings.css';
import { motion, useIsPresent } from 'motion/react';
import { Backdrop, MotionDialog } from './motion';
import { Switch } from './Switch';
import ChatSelect from './ChatSelect';
import type { PluginContributions } from './types';
import { checkedAgo, updateSummary, useUpdateState } from './Updates';

export type SettingsCommand = {
  label: string;
  hint: string;
  action(): void;
  icon: ComponentType<{ size?: number }>;
};

const sections = [
  { id: 'appearance', label: 'Appearance', icon: Sparkles },
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'plugins', label: 'Plugins', icon: Zap },
  { id: 'commands', label: 'Commands', icon: Command },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'updates', label: 'Updates', icon: Download },
  { id: 'about', label: 'About & data', icon: Info },
] as const;
/** What each section is also called, so its settings turn up under those names. */
const sectionWords: Record<string, string> = Object.fromEntries(
  [
    ['appearance', 'theme colors look display'],
    ['general', 'startup'],
    ['editor', 'code text'],
    ['terminal', 'shell console command line'],
    ['chat', 'agent ai assistant'],
    ['notifications', 'alerts'],
    ['plugins', 'extensions'],
    ['commands', 'palette'],
    ['shortcuts', 'keyboard hotkeys keybindings keys'],
    ['updates', 'upgrade new version release download install restart check'],
    ['about', 'version data privacy storage'],
  ].map(([id, extra]) => [id, `${sections.find((item) => item.id === id)?.label ?? ''} ${extra}`]),
);
type Choice<T> = readonly [value: T, label: string];
type SwitchKey = { [K in keyof Preferences]: Preferences[K] extends boolean ? K : never }[keyof Preferences];
const numbers = (list: number[], suffix: string): Choice<number>[] =>
  list.map((n) => [n, n.toLocaleString() + suffix]);
const fonts: Choice<string>[] = fontFamilies.map((name) => [name, name]);

export default function Settings({
  value,
  onChange,
  error,
  onClose,
  commands = [],
  onOpenPlugins,
  onInstallUpdate,
  pluginThemes = [],
  shells = [],
}: {
  shells?: { id: string; label: string }[];
  value: Preferences;
  onChange(value: Preferences): void;
  error: string;
  onClose(): void;
  commands?: SettingsCommand[];
  onOpenPlugins?(): void;
  /** Saves open work and restarts into a downloaded update. */
  onInstallUpdate?(): void;
  /** Themes from enabled plugins. */
  pluginThemes?: PluginContributions['themes'];
}) {
  const [section, setSection] = useState<string>('appearance');
  const update = useUpdateState();
  const [query, setQuery] = useState('');
  const [reset, setReset] = useState(false);
  const content = useRef<HTMLElement>(null);
  const [noResults, setNoResults] = useState(false);
  // Each category opens at its top, not at the previous one's scroll position.
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [section]);
  // Nothing on screen for the query: say so rather than showing an empty page.
  useLayoutEffect(() => {
    setNoResults(
      !!query.trim() &&
        !content.current?.querySelector(
          'section .preferences-row, section .preferences-theme-setting, section .preferences-command, section .preferences-copy',
        ),
    );
  }, [query, update]);
  const host = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const present = useIsPresent();
  // Off when Settings closes to run a command: the command's own dialog keeps focus.
  const restoreFocus = useRef(true);
  useEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
    host.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      if (restoreFocus.current) previous.current?.focus();
    };
  }, []);
  // The dialog stays mounted while it fades out; return focus as soon as it starts closing.
  useEffect(() => {
    if (!present && restoreFocus.current) previous.current?.focus();
  }, [present]);
  const change = <K extends keyof Preferences>(key: K, next: Preferences[K]) => {
    setReset(false);
    onChange({ ...value, [key]: next });
  };
  // The section being rendered. show() is called at the top of each section, before its rows,
  // so a search for "terminal" also finds every setting in the Terminal section.
  let scope = '';
  // Section names only count once three letters are typed, so one letter does not pull in a whole section.
  const matches = (text: string, keywords = '') =>
    matchesSearch(query, text, keywords, query.trim().length >= 3 ? scope : '');
  const show = (id: string) => {
    scope = sectionWords[id] ?? '';
    return query.trim() || section === id;
  };
  // A control given as a function is a dropdown: it is named by the row title, and the row is a
  // plain div so clicking the text does not reach into the control.
  const row = (
    title: string,
    description: string,
    control: ReactNode | ((title: string) => ReactNode),
    keywords = '',
  ) => {
    if (!matches(title + ' ' + description, keywords)) return false;
    const text = (
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    );
    return typeof control === 'function' ? (
      <div className="preferences-row">
        {text}
        {control(title)}
      </div>
    ) : (
      <label className="preferences-row">
        {text}
        {control}
      </label>
    );
  };
  const choose = <K extends keyof Preferences>(
    key: K,
    options: readonly Choice<Preferences[K]>[],
    disabled = false,
  ) =>
    (title: string) => (
      <ChatSelect
        variant="field"
        compact
        label={title}
        value={String(value[key])}
        disabled={disabled}
        options={options.map(([option, label]) => ({ value: String(option), label }))}
        onChange={(next) => {
          const found = options.find(([option]) => String(option) === next);
          if (found) change(key, found[0]);
        }}
      />
    );
  const toggle = (key: SwitchKey) => (
    <Switch checked={value[key]} onChange={(next) => change(key, next)} />
  );
  return (
    <Backdrop
      className="modal-backdrop preferences-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <MotionDialog
        className="preferences"
        dialogRef={host}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
          if (event.key === 'Tab') {
            const items = [
              ...host.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input, select, [tabindex="0"]',
              ),
            ];
            const first = items[0],
              last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="preferences-body">
          <button
            className="icon-button preferences-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X size={18} />
          </button>
          <aside className="preferences-sidebar">
            <h2 id="preferences-title" className="preferences-title">
              Settings
            </h2>
            <div className="preferences-search">
              <Search size={15} />
              <input
                aria-label="Search settings"
                placeholder="Search settings…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <nav aria-label="Settings categories">
              {sections.map(({ id, label, icon: Icon }) => (
                <Fragment key={id}>
                  {id === 'commands' && <span className="preferences-nav-break" aria-hidden="true" />}
                  <button
                    aria-current={!query && section === id ? 'page' : undefined}
                    onClick={() => {
                      setSection(id);
                      setQuery('');
                      setReset(false);
                    }}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                </Fragment>
              ))}
            </nav>
          </aside>
          <main
            ref={content}
            className="preferences-content"
            data-searching={query.trim() ? '' : undefined}
            tabIndex={0}
            aria-label="Settings content"
          >
            {query && <h3>Search results</h3>}
            {show('editor') && (
              <section>
                <h3>Editor</h3>
                <p className="preferences-description">
                  A comfortable space to read and write code.
                </p>
                <div className="preferences-group">
                  {row(
                    'Font size',
                    'Text size in the editor and diff view.',
                    choose('fontSize', numbers(fontSizes, ' px')),
                    'text zoom bigger smaller typography',
                  )}
                  {row(
                    'Font family',
                    'Monospace font for the editor. Fonts that are not installed fall back to Cascadia Code.',
                    choose('fontFamily', fonts),
                    'typeface monospace code',
                  )}
                  {row('Word wrap', 'Wrap long lines to fit the editor width.', toggle('wordWrap'),
                    'wrap lines overflow horizontal scroll',
                  )}
                  {row(
                    'Tab size',
                    'Number of spaces displayed for a tab.',
                    choose('tabSize', numbers([2, 4, 8], ' spaces')),
                    'indent indentation spaces tabs',
                  )}
                  {row(
                    'Minimap',
                    'Show an overview of your code beside the editor.',
                    toggle('minimap'),
                    'overview outline scrollbar',
                  )}
                </div>
                {!query && (
                  <div className="preferences-preview">
                    <div>
                      <span>PREVIEW</span>
                      <span>workspace.ts</span>
                    </div>
                    <pre
                      style={{
                        fontSize: value.fontSize,
                        fontFamily: fontStack(value.fontFamily),
                        whiteSpace: value.wordWrap ? 'pre-wrap' : 'pre',
                        tabSize: value.tabSize,
                      }}
                    >
                      <code>
                        <span className="preview-comment">// Make room for your next idea.</span>
                        {'\n'}
                        <span className="preview-keyword">function</span>
                        {' welcome() {\n\t'}
                        <span className="preview-keyword">return</span>{' '}
                        <span className="preview-string">"Hello, workspace."</span>
                        {';\n}'}
                      </code>
                    </pre>
                  </div>
                )}
              </section>
            )}
            {show('terminal') && (
              <section>
                <h3>Terminal</h3>
                <p className="preferences-description">Changes apply to open and new terminals.</p>
                <div className="preferences-group">
                  {row(
                    'Terminal font size',
                    'Adjust the size of shell and coding agent output.',
                    choose('terminalFontSize', numbers(fontSizes, ' px')),
                    'text zoom console shell bigger smaller',
                  )}
                  {row(
                    'Terminal font',
                    'Font for shell and coding agent output.',
                    choose('terminalFontFamily', [['editor', 'Same as editor'], ...fonts]),
                    'typeface console shell family',
                  )}
                  {shells.length > 1 &&
                    row(
                      'Default shell',
                      'Used for new terminals, and selected first when choosing a shell.',
                      (title) => (
                        <ChatSelect
                          variant="field"
                          compact
                          label={title}
                          value={shells.some((shell) => shell.id === value.defaultShell) ? value.defaultShell : ''}
                          options={[
                            { value: '', label: `System default (${shells[0].label})` },
                            ...shells.map((shell) => ({ value: shell.id, label: shell.label })),
                          ]}
                          onChange={(next) => change('defaultShell', next)}
                        />
                      ),
                    'powershell cmd bash zsh command prompt',
                  )}
                  {row(
                    'Blinking cursor',
                    'Make the terminal cursor blink while active.',
                    toggle('cursorBlink'),
                    'caret blink',
                  )}
                  {row(
                    'Scrollback',
                    'Maximum lines kept in each terminal. Lowering this discards older output.',
                    choose('scrollback', numbers([1000, 5000, 10000, 20000], ' lines')),
                    'history buffer lines output',
                  )}
                </div>
                {!query && (
                  <div className="preferences-info">
                    <SquareTerminal size={19} />
                    <p>
                      Bring your existing tools
                      <small>
                        Choose a shell when opening a terminal. Coding agents use your installed CLI
                        and its existing account and configuration.
                      </small>
                    </p>
                  </div>
                )}
              </section>
            )}
            {show('appearance') && (
              <section>
                <h3>Appearance</h3>
                <p className="preferences-description">How the workspace looks and moves.</p>
                {matches('Color theme Applies to the workspace, editor, and terminal.', ['dark light color colour', ...Object.values(themes).map((t) => `${t.label} ${t.description}`), ...pluginThemes.map((t) => `${t.label} ${t.plugin}`)].join(' ')) && (
                  <div className="preferences-theme-setting">
                    <strong>Color theme</strong>
                    <small>Applies to the workspace, editor, and terminal.</small>
                    <div className="preferences-themes" role="group" aria-label="Color theme">
                      {(Object.keys(themes) as ThemeName[]).map((name) => {
                        const theme = themes[name];
                        const pressed = value.theme === name && !pluginThemes.some((item) => item.key === value.pluginTheme);
                        return (
                          <button
                            key={name}
                            type="button"
                            className="preferences-theme"
                            aria-pressed={pressed}
                            onClick={() => {
                              setReset(false);
                              onChange({ ...value, theme: name, pluginTheme: '' });
                            }}
                          >
                            <span className="preferences-theme-swatch" style={{ background: theme.chrome }} aria-hidden="true">
                              <span style={{ background: theme.stage }}>
                                <i style={{ background: theme.accent }} />
                                <i style={{ background: theme.muted }} />
                                <i style={{ background: theme.raised }} />
                              </span>
                            </span>
                            <span className="preferences-theme-label"><strong>{theme.label}</strong><small>{theme.description}</small></span>
                            {pressed && <Check size={15} aria-hidden="true" />}
                          </button>
                        );
                      })}
                      {pluginThemes.map((theme) => (
                        <button
                          key={theme.key}
                          type="button"
                          className="preferences-theme"
                          aria-pressed={value.pluginTheme === theme.key}
                          onClick={() => change('pluginTheme', theme.key)}
                        >
                          <span className="preferences-theme-swatch" style={{ background: theme.colors.chrome }} aria-hidden="true">
                            <span style={{ background: theme.colors.stage }}>
                              <i style={{ background: theme.colors.accent }} />
                              <i style={{ background: theme.colors.muted }} />
                              <i style={{ background: theme.colors.raised }} />
                            </span>
                          </span>
                          <span className="preferences-theme-label"><strong>{theme.label}</strong><small>from {theme.plugin}</small></span>
                          {value.pluginTheme === theme.key && <Check size={15} aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="preferences-group">
                  {row(
                    'Reduce motion',
                    'Open and close panels, menus and dialogs instantly instead of animating them.',
                    toggle('reduceMotion'),
                    'animation animations transitions accessibility',
                  )}
                </div>
              </section>
            )}
            {show('plugins') && onOpenPlugins && (
              <section>
                <h3>Plugins</h3>
                <p className="preferences-description">
                  Commands, agent presets, prompts, MCP servers and themes from plugins you install.
                </p>
                <div className="preferences-group">
                  {row(
                    'Manage plugins',
                    'Add marketplaces, then install, enable, update or remove plugins.',
                    <button type="button" className="secondary-button" onClick={onOpenPlugins}>
                      Open Plugins
                    </button>,
                    'extensions marketplace install mcp',
                  )}
                </div>
              </section>
            )}
            {show('general') && (
              <section>
                <h3>General</h3>
                <p className="preferences-description">How the workspace starts.</p>
                <div className="preferences-group">
                  {row(
                    'On startup',
                    'Projects with running terminals, or opened from the command line, always reopen.',
                    choose('startup', [
                      ['last', 'Reopen last project'],
                      ['none', 'Start with no project open'],
                    ]),
                    'launch open restore reopen project last',
                  )}
                </div>
              </section>
            )}
            {show('chat') && (
              <section>
                <h3>Chat</h3>
                <p className="preferences-description">
                  Defaults for new chats. You can still change them in each chat.
                </p>
                <div className="preferences-group">
                  {row(
                    'Default provider',
                    'Provider for new chats. Its default model is chosen automatically.',
                    choose('chatProvider', [
                      ['last', 'Last used'],
                      ['codex', 'Codex'],
                      ['claude', 'Claude Code'],
                      ['ollama', 'Ollama'],
                    ]),
                    'model codex claude ollama ai agent',
                  )}
                  {row(
                    'Default permissions',
                    'What coding agents may do in new chats. Full access is only available per chat.',
                    choose('chatPermission', [
                      ['last', 'Last used'],
                      ['ask', 'Ask for approval'],
                      ['auto', 'Approve safe actions'],
                    ]),
                    'approval approve ask access safe',
                  )}
                </div>
              </section>
            )}
            {show('notifications') && (
              <section>
                <h3>Notifications</h3>
                <p className="preferences-description">
                  Plan usage alerts for Claude Code and Codex.
                </p>
                <div className="preferences-group">
                  {row('Agent done sound', 'Play a chime when an agent finishes working.', toggle('doneSound'),
                    'chime audio beep finished complete',
                  )}
                  {row(
                    'Usage alerts',
                    'Notify when plan usage passes a threshold, reaches its limit, or resets.',
                    toggle('usageAlerts'),
                    'limit quota plan rate',
                  )}
                  {row(
                    'Warning threshold',
                    'First alert for each usage window.',
                    choose('usageWarningAt', numbers(usageWarningLevels, '%'), !value.usageAlerts),
                    'percent alert limit quota',
                  )}
                  {row(
                    'Critical threshold',
                    'Second alert, before the limit is reached.',
                    choose('usageCriticalAt', numbers(usageCriticalLevels, '%'), !value.usageAlerts),
                    'percent alert limit quota',
                  )}
                </div>
              </section>
            )}
            {show('commands') && commands.some((c) => matches(c.label + ' command', c.hint)) && (
              <section>
                <h3>Commands</h3>
                <p className="preferences-description">
                  Everything the command palette can do. Run one here, or press Ctrl K anywhere.
                </p>
                <div className="preferences-commands">
                  {commands
                    .filter((command) => matches(command.label + ' command', command.hint))
                    .map(({ label, hint, action, icon: Icon }) => (
                      <button
                        type="button"
                        key={label}
                        className="preferences-command"
                        onClick={() => {
                          restoreFocus.current = false;
                          // Move focus out of the closing dialog first, so the
                          // command's own dialog (Quick open, Run command) can take it.
                          previous.current?.focus();
                          onClose();
                          action();
                        }}
                      >
                        <Icon size={16} />
                        <span>{label}</span>
                        {hint && <kbd>{hint.replace(/ (?=\S)/g, ' + ')}</kbd>}
                        <CornerDownLeft
                          size={14}
                          className="preferences-command-run"
                          aria-hidden="true"
                        />
                      </button>
                    ))}
                </div>
              </section>
            )}
            {show('shortcuts') && (
              <section>
                <h3>Keyboard shortcuts</h3>
                <p className="preferences-description">
                  Move around your workspace without leaving the keyboard.
                </p>
                <div className="preferences-group">
                {[
                  ['Open project folder', 'Ctrl + O'],
                  ['Command palette', 'Ctrl + K'],
                  ['Quick open file', 'Ctrl + P'],
                  ['Save current file', 'Ctrl + S'],
                  ['New terminal', 'Ctrl + `'],
                  ['Copy terminal selection', 'Ctrl + C / Ctrl + Shift + C'],
                  ['Paste into terminal', 'Ctrl + V / Ctrl + Shift + V'],
                  ['Close dialog', 'Esc'],
                ]
                  .filter(([label, keys]) => matches(label, keys))
                  .map(([label, keys]) => (
                    <div className="preferences-row" key={label}>
                      <strong>{label}</strong>
                      <kbd>{keys}</kbd>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {show('updates') && (
              <section>
                <h3>Updates</h3>
                <p className="preferences-description">
                  Veyo looks for new releases in the background and downloads them for you.
                </p>
                <div className="preferences-group">
                  {row('Current version', 'The version installed on this device.', <span>{version}</span>)}
                  {update &&
                    row(
                      update.status === 'ready' ? `Veyo ${update.latest} is ready` : 'Check for updates',
                      `${updateSummary(update)}${update.supported && update.status !== 'checking' && update.status !== 'downloading' ? ` ${checkedAgo(update.checkedAt)}.` : ''}`,
                      update.status === 'ready' ? (
                        <button type="button" className="primary-button" aria-label="Restart to update" onClick={() => onInstallUpdate?.()}>
                          Restart to update
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          aria-label="Check for updates"
                          disabled={!update.supported || update.status === 'checking' || update.status === 'downloading'}
                          onClick={() => void window.workspace?.updateCheck()}
                        >
                          {update.status === 'checking' ? 'Checking…' : 'Check for updates'}
                        </button>
                      ),
                      'upgrade new release download install restart latest',
                    )}
                </div>
              </section>
            )}
            {show('about') && (
              <section>
                <h3>About & data</h3>
                <p className="preferences-description">Veyo · Local desktop coding workspace</p>
                <div className="preferences-group">
                  {matches('Version Veyo', 'build release number') && (
                    <div className="preferences-row">
                      <strong>Version</strong>
                      <span>{version}</span>
                    </div>
                  )}
                </div>
                {matches('Stored on your device Connected tools Returning to work', 'local data storage privacy projects drafts terminals presets') && (
                  <div className="preferences-copy">
                    <h4>Stored on your device</h4>
                    <p>
                      Preferences stay in this app on this device. Project lists, layouts, open
                      tabs, and unsaved drafts are saved in the app’s local data directory. Source
                      files stay in their project folders.
                    </p>
                    <h4>Connected tools</h4>
                    <p>
                      Terminals run with your user permissions. Coding agents and chat providers
                      follow their own connection and data settings.
                    </p>
                    <h4>Returning to work</h4>
                    <p>
                      Saved terminal presets can start fresh sessions after a restart. Previous
                      processes and commands are not replayed.
                    </p>
                  </div>
                )}
              </section>
            )}
            {noResults && (
              <p className="preferences-search-empty" role="status">
                No settings match “{query.trim()}”.
              </p>
            )}
            {query && (
              <p className="preferences-search-help">
                Search matches setting names, descriptions and related words, in any order. Clear
                the search to browse all settings.
              </p>
            )}
          </main>
        </div>
        <footer className="preferences-footer">
          <span role={error ? 'alert' : 'status'} className={error ? 'preferences-error' : ''}>
            {error}
          </span>
          <div>
            {reset ? (
              <>
                <span>Restore all settings to defaults?</span>
                <button onClick={() => setReset(false)}>Cancel</button>
                <button
                  onClick={() => {
                    onChange({ ...defaults });
                    setReset(false);
                  }}
                >
                  Confirm reset
                </button>
              </>
            ) : (
              <button onClick={() => setReset(true)}>
                <RotateCcw size={14} />
                Restore defaults
              </button>
            )}
          </div>
        </footer>
      </MotionDialog>
    </Backdrop>
  );
}
