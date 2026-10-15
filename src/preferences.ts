import { useState } from 'react';

type Value = string | number | boolean;
type Setting<T extends Value> = { fallback: T; valid(value: unknown): value is T };
const oneOf = <T extends Value>(fallback: T, options: readonly T[]): Setting<T> => ({
  fallback,
  valid: (value): value is T => (options as readonly unknown[]).includes(value),
});

export const fontSizes = [11, 12, 13, 14, 15, 16, 18, 20, 24];
/** Monospace fonts offered in Settings. A missing font falls back to the built-in stack. */
export const fontFamilies = [
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'Courier New',
];
export const usageWarningLevels = [50, 60, 70, 75, 80];
export const usageCriticalLevels = [85, 90, 95];

// One entry per setting: its default and what a saved value may be.
const schema = {
  theme: oneOf<'graphite' | 'light'>('graphite', ['graphite', 'light']),
  // A plugin theme ("plugin:theme"), or '' for none. When the plugin is disabled or
  // removed, the built-in theme above applies again.
  pluginTheme: {
    fallback: '' as string,
    valid: (value: unknown): value is string =>
      typeof value === 'string' && (value === '' || /^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/.test(value)),
  },
  fontSize: oneOf<number>(12, fontSizes),
  fontFamily: oneOf<string>('Cascadia Code', fontFamilies),
  wordWrap: oneOf<boolean>(false, [true, false]),
  tabSize: oneOf<number>(2, [2, 4, 8]),
  minimap: oneOf<boolean>(false, [true, false]),
  terminalFontSize: oneOf<number>(12, fontSizes),
  // 'editor' follows the editor font.
  terminalFontFamily: oneOf<string>('editor', ['editor', ...fontFamilies]),
  cursorBlink: oneOf<boolean>(true, [true, false]),
  scrollback: oneOf<number>(5000, [1000, 5000, 10000, 20000]),
  // '' uses the system default. Shells are detected at runtime, so any short id is kept
  // and checked against the available shells when a terminal opens.
  defaultShell: {
    fallback: '' as string,
    valid: (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9-]{0,32}$/.test(value),
  },
  reduceMotion: oneOf<boolean>(false, [true, false]),
  startup: oneOf<'last' | 'none'>('last', ['last', 'none']),
  // 'last' keeps whatever the previous chat used. Full access is never a default.
  chatProvider: oneOf<'last' | 'codex' | 'claude' | 'ollama'>('last', ['last', 'codex', 'claude', 'ollama']),
  chatPermission: oneOf<'last' | 'ask' | 'auto'>('last', ['last', 'ask', 'auto']),
  doneSound: oneOf<boolean>(true, [true, false]),
  usageAlerts: oneOf<boolean>(true, [true, false]),
  usageWarningAt: oneOf<number>(75, usageWarningLevels),
  usageCriticalAt: oneOf<number>(90, usageCriticalLevels),
};
export type Preferences = { -readonly [K in keyof typeof schema]: (typeof schema)[K]['fallback'] };
export const defaults = Object.fromEntries(
  Object.entries(schema).map(([name, setting]) => [name, setting.fallback]),
) as Preferences;

/** A CSS font stack that starts with the chosen font and falls back to fonts Windows ships. */
export function fontStack(family: string) {
  return `"${family}", "Cascadia Code", Consolas, monospace`;
}

const key = 'veyo.preferences.v1';
export function readPreferences(): Preferences {
  try {
    const saved = localStorage.getItem(key);
    const value = saved
      ? JSON.parse(saved)
      : {
          fontSize: Number(localStorage.getItem('font-size')) || 12,
          wordWrap: localStorage.getItem('word-wrap') === 'true',
        };
    const result: Record<string, Value> = { ...defaults };
    for (const [name, setting] of Object.entries(schema))
      if (setting.valid(value?.[name])) result[name] = value[name];
    return result as Preferences;
  } catch {
    return { ...defaults };
  }
}
export function usePreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [saveError, setSaveError] = useState('');
  function update(next: Preferences) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setPreferences(next);
      setSaveError('');
    } catch {
      setSaveError(
        'Could not save preferences. Your previous settings are still active. Try again.',
      );
    }
  }
  return { preferences, update, saveError };
}
