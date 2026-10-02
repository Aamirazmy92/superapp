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
    label: 'Dark', description: 'Claude dark',
    chrome: '#111111', stage: '#151515', well: '#111111', raised: '#212121',
    accent: '#d97757', foreground: '#f0efec', muted: '#898781',
    selection: '#264f78', keyword: '#c792ea', string: '#a5d6a7',
  },
  midnight: {
    label: 'Midnight', description: 'Cool blue tones',
    chrome: '#0c1220', stage: '#131c2b', well: '#0f1724', raised: '#1c2838',
    accent: '#b8d5ff', foreground: '#e4edfa', muted: '#91a5c0',
    selection: '#345681', keyword: '#b7adff', string: '#92d8c1',
  },
  plum: {
    label: 'Plum', description: 'Warm violet tones',
    chrome: '#171119', stage: '#211923', well: '#1a141d', raised: '#2b2230',
    accent: '#e8c7ee', foreground: '#f0e8f0', muted: '#b5a0b7',
    selection: '#684869', keyword: '#d8a9f1', string: '#b3d9b8',
  },
  light: {
    label: 'Light', description: 'Claude light',
    chrome: '#f4f4f1', stage: '#faf9f7', well: '#f4f4f1', raised: '#ededea',
    accent: '#c6613f', foreground: '#141413', muted: '#6f6e69',
    selection: '#cfe2f7', keyword: '#8a3fb8', string: '#3d7a2a',
  },
};

export function terminalTheme(name: ThemeName) {
  const palette = themes[name];
  const light = name === 'light';
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
