import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker.js?worker';
import { themes, type ThemeName } from './themes';
// Bundle editor assets locally: opening a project never requires a CDN.
self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === 'json'
      ? new JsonWorker()
      : ['typescript', 'javascript'].includes(label)
        ? new TsWorker()
        : ['css', 'scss', 'less'].includes(label)
          ? new CssWorker()
          : ['html', 'handlebars', 'razor'].includes(label)
            ? new HtmlWorker()
            : new EditorWorker(),
};
loader.config({ monaco });
// Cross-file module resolution needs a project language service, planned next.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});
monaco.typescript.typescriptDefaults.setCompilerOptions({
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  target: monaco.typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
});
monaco.editor.defineTheme('superapp', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7d7c77', fontStyle: 'italic' },
    { token: 'string', foreground: 'a5d6a7' },
    { token: 'string.key.json', foreground: '9cc4f0' },
    { token: 'string.value.json', foreground: 'a5d6a7' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'number', foreground: 'f2b98b' },
    { token: 'type', foreground: '8fd3e8' },
    { token: 'delimiter', foreground: '898781' },
  ],
  colors: {
    'editor.background': '#151515',
    'editor.foreground': '#f0efec',
    'editorLineNumber.foreground': '#4d4d4c',
    'editorLineNumber.activeForeground': '#c3c2b7',
    'editor.selectionBackground': '#264f78',
    'editor.inactiveSelectionBackground': '#2a2d32',
    'editor.lineHighlightBackground': '#1c1c1c',
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#d97757',
    'editorWidget.background': '#212121',
    'editorWidget.border': '#343434',
    'editorGutter.background': '#151515',
    'editorIndentGuide.background1': '#262625',
    'editorIndentGuide.activeBackground1': '#3c3c3b',
    'editorBracketMatch.background': '#2d2d2d',
    'editorBracketMatch.border': '#4d4d4c',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff26',
    'scrollbarSlider.activeBackground': '#ffffff33',
    'minimap.background': '#151515',
  },
});

for (const name of ['midnight', 'plum', 'light'] as ThemeName[]) {
  const palette = themes[name];
  const light = name === 'light';
  monaco.editor.defineTheme(`superapp-${name}`, {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: palette.muted.slice(1), fontStyle: 'italic' },
      { token: 'string', foreground: palette.string.slice(1) },
      { token: 'keyword', foreground: palette.keyword.slice(1) },
      { token: 'number', foreground: light ? 'a05418' : 'f2b98b' },
      { token: 'type', foreground: light ? '126685' : '8fd3e8' },
    ],
    colors: {
      'editor.background': palette.stage,
      'editor.foreground': palette.foreground,
      'editorGutter.background': palette.stage,
      'minimap.background': palette.stage,
      'editorLineNumber.foreground': palette.muted,
      'editorLineNumber.activeForeground': palette.foreground,
      'editor.selectionBackground': palette.selection,
      'editor.inactiveSelectionBackground': palette.raised,
      'editor.lineHighlightBackground': palette.raised,
      'editorCursor.foreground': palette.accent,
      'editorWidget.background': palette.raised,
      'editorWidget.border': palette.muted,
      ...(light ? {
        'editorIndentGuide.background1': '#e8e5da',
        'editorIndentGuide.activeBackground1': '#c9c5b8',
        'editorBracketMatch.background': '#f1e4dc',
        'editorBracketMatch.border': '#d9a58f',
        'scrollbarSlider.background': '#73726c25',
        'scrollbarSlider.hoverBackground': '#73726c45',
        'scrollbarSlider.activeBackground': '#73726c65',
      } : {}),
    },
  });
}
