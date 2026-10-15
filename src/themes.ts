import type { Preferences } from './preferences';

export type ThemeName = Preferences['theme'];

export const themes: Record<ThemeName, {
  label: string;
  description: string;
  chrome: string;
  stage: string;
  well: string;
  raised: string;
  accent: string;
  foreground: string;
  muted: string;
  selection: string;
  keyword: string;
  string: string;
}> = {
  graphite: {
    label: 'Ember', description: 'Warm charcoal tones',
    chrome: '#161615', stage: '#1b1b1a', well: '#171716', raised: '#262625',
    accent: '#d97757', foreground: '#ececea', muted: '#8d8d8a',
    selection: '#264f78', keyword: '#c792ea', string: '#a5d6a7',
  },
  light: {
    label: 'Linen', description: 'Soft paper tones',
    chrome: '#f4f4f1', stage: '#faf9f7', well: '#f4f4f1', raised: '#ededea',
    accent: '#c6613f', foreground: '#141413', muted: '#6f6e69',
    selection: '#cfe2f7', keyword: '#8a3fb8', string: '#3d7a2a',
  },
};

export type Palette = Omit<(typeof themes)[ThemeName], 'label' | 'description'>;
export type PluginTheme = { key: string; label: string; plugin: string; base: ThemeName; colors: Palette };

// Themes from enabled plugins, keyed "plugin:theme". App replaces the set whenever
// plugins change, so a disabled plugin's theme stops applying at once.
const pluginThemes = new Map<string, PluginTheme>();
export function setPluginThemes(list: PluginTheme[]) {
  pluginThemes.clear();
  for (const theme of list) pluginThemes.set(theme.key, theme);
}
/** The plugin theme for a preference value, if that plugin is still enabled. */
export function pluginTheme(key: string | undefined) {
  return key ? pluginThemes.get(key) : undefined;
}
/** The workspace CSS colours a plugin theme sets on top of its base theme. */
export function pluginThemeTokens({ colors }: PluginTheme): Record<string, string> {
  const mix = (colour: string, amount: number) => `color-mix(in srgb, ${colour} ${amount}%, transparent)`;
  return {
    '--chrome': colors.chrome,
    '--stage': colors.stage,
    '--well': colors.well,
    '--raised': colors.raised,
    '--overlay': colors.raised,
    '--text': colors.foreground,
    '--text-soft': `color-mix(in srgb, ${colors.foreground} 80%, ${colors.muted})`,
    '--muted': colors.muted,
    '--accent': colors.accent,
    '--accent-strong': colors.accent,
    '--accent-soft': mix(colors.accent, 14),
    '--accent-faint': mix(colors.accent, 7),
    '--preview-keyword': colors.keyword,
    '--preview-string': colors.string,
  };
}

export function terminalTheme(name: ThemeName, pluginKey?: string) {
  const plugin = pluginTheme(pluginKey);
  const palette = plugin?.colors ?? themes[name];
  const light = (plugin?.base ?? name) === 'light';
  return {
    background: palette.well,
    foreground: palette.foreground,
    cursor: palette.accent,
    cursorAccent: palette.well,
    selectionBackground: palette.selection,
    black: light ? '#303b4b' : palette.chrome,
    brightBlack: palette.muted,
    red: light ? '#b83c43' : '#ee9a92', brightRed: light ? '#a92b34' : '#ffb0a9',
    green: light ? '#176b4b' : '#72d7a8', brightGreen: light ? '#0d704b' : '#9be8c3',
    yellow: light ? '#866016' : '#dab776', brightYellow: light ? '#795511' : '#ebca8a',
    blue: light ? '#2558a5' : '#91a5ff', brightBlue: light ? '#174d9d' : '#b2beff',
    magenta: light ? '#7948a9' : '#c39ce7', brightMagenta: light ? '#6d36a4' : '#d9b5f6',
    cyan: light ? '#146f78' : '#7bcac7', brightCyan: light ? '#09646e' : '#9cddda',
    white: light ? '#516074' : palette.foreground, brightWhite: light ? '#202936' : '#f5f5f5',
  };
}
