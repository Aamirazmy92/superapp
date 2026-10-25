import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  ListFilter,
  MessageSquare,
  Redo2,
  Search,
  Undo2,
  WrapText,
} from './icons';
import { editorContent, editorPath } from './editorModel';
import { language } from './workspaceModel';
import { fontStack, type Preferences } from './preferences';
import { editorThemeName } from './editorSetup';
import type { OpenFile } from './types';

/** Disposes the editor models of one scheme that are no longer open (the chat file panel has its own). */
export function releaseClosedEditorModels(paths: string[], scheme = 'veyo') {
  const open = new Set(paths);
  for (const model of monaco.editor.getModels())
    if (
      model.uri.scheme === scheme &&
      model.uri.query !== 'disk' &&
      !open.has(model.uri.toString())
    )
      model.dispose();
}

export default function FileEditor({
  projectId,
  file,
  preferences,
  busy,
  editorRef,
  reveal,
  onChange,
  onSave,
  onAsk,
  onUseDisk,
  onWrap,
  modelScheme,
}: {
  projectId: string;
  file: OpenFile;
  preferences: Preferences;
  busy: boolean;
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
  reveal?: { path: string; line: number; column: number } | null;
  onChange(content: string): void;
  onSave(keepMine?: boolean): void;
  /** Without it the "Ask chat" button is hidden (the chat file panel is already in a chat). */
  onAsk?(): void;
  onUseDisk(): void;
  onWrap(): void;
  /** A separate model namespace keeps this editor's files from sharing models with the Code view. */
  modelScheme?: string;
}) {
  const [status, setStatus] = useState({
    line: 1,
    column: 1,
    selected: 0,
    eol: 'LF',
    tabSize: preferences.tabSize,
    spaces: true,
  });
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [canFormat, setCanFormat] = useState(false);
  const subscriptions = useRef<monaco.IDisposable[]>([]);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const savedRef = useRef(file.saved);
  savedRef.current = file.saved;
  const contentRef = useRef(file.content);
  contentRef.current = file.content;
  const path = editorPath(projectId, file.path, modelScheme);
  useEffect(() => {
    if (!file.conflict) return;
    return () => {
      // The React wrapper disposes models before its diff widget. Retain the
      // original until that widget has finished releasing its subscriptions.
      queueMicrotask(() => monaco.editor.getModel(monaco.Uri.parse(`${path}?disk`))?.dispose());
    };
  }, [path, !!file.conflict]);
  const dirty = file.content !== file.saved;
  const clear = () => {
    subscriptions.current.forEach((item) => item.dispose());
    subscriptions.current = [];
    editorRef.current = null;
  };
  useEffect(() => () => clear(), []);
  const mount = (editor: monaco.editor.IStandaloneCodeEditor, listen = false) => {
    clear();
    editorRef.current = editor;
    setReady(true);
    // Retained models preserve history, but a disk-version resolution may
    // replace the draft while the normal editor is unmounted for comparison.
    const value = contentRef.current.replace(/^\uFEFF/, '');
    const model = editor.getModel();
    if (model && editor.getValue() !== value) {
      editor.pushUndoStop();
      editor.executeEdits('workspace', [
        { range: model.getFullModelRange(), text: value, forceMoveMarkers: true },
      ]);
      editor.pushUndoStop();
    }
    const update = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      const selection = editor.getSelection();
      if (!model) return;
      const options = model.getOptions();
      setStatus({
        line: position?.lineNumber || 1,
        column: position?.column || 1,
        selected: selection ? model.getValueLengthInRange(selection) : 0,
        eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
        tabSize: options.tabSize,
        spaces: options.insertSpaces,
      });
      setCanUndo(model.canUndo());
      setCanRedo(model.canRedo());
      setCanFormat(editor.getAction('editor.action.formatDocument')?.isSupported() ?? false);
    };
    let providerTimer: ReturnType<typeof setTimeout>;
    const refreshModel = () => {
      update();
      clearTimeout(providerTimer);
      providerTimer = setTimeout(update, 800);
    };
    const refreshHistory = () =>
      queueMicrotask(() => {
        if (editorRef.current === editor) update();
      });
    subscriptions.current = [
      editor.onDidChangeCursorSelection(update),
      editor.onDidChangeModel(refreshModel),
      editor.onDidChangeModelContent(refreshHistory),
      editor.onDidChangeModelLanguage(refreshModel),
      editor.onDidChangeModelOptions(update),
      editor.onDidDispose(() => {
        if (editorRef.current === editor) {
          clear();
          setReady(false);
        }
      }),
    ];
    if (listen)
      subscriptions.current.push(
        editor.onDidChangeModelContent(() =>
          changeRef.current(editorContent(editor.getValue(), savedRef.current)),
        ),
      );
    if (reveal?.path === file.path) {
      editor.setPosition({ lineNumber: reveal.line, column: reveal.column });
      editor.revealLineInCenter(reveal.line);
    }
    refreshModel();
    // Providers register asynchronously when a new language is first opened.
    subscriptions.current.push({ dispose: () => clearTimeout(providerTimer) });
  };
  const run = (id: string) => {
    const editor = editorRef.current;
    editor?.focus();
    if (id === 'undo' || id === 'redo') editor?.trigger('toolbar', id, null);
    else void editor?.getAction(id)?.run();
  };
  const options: monaco.editor.IStandaloneEditorConstructionOptions = {
    fontSize: preferences.fontSize,
    fontFamily: fontStack(preferences.fontFamily),
    minimap: { enabled: preferences.minimap },
    padding: { top: 16, bottom: 20 },
    lineHeight: Math.round(preferences.fontSize * 1.55),
    scrollBeyondLastLine: false,
    smoothScrolling: !preferences.reduceMotion,
    cursorSmoothCaretAnimation: preferences.reduceMotion ? 'off' : 'on',
    cursorBlinking: preferences.reduceMotion ? 'blink' : 'smooth',
    wordWrap: preferences.wordWrap ? 'on' : 'off',
    automaticLayout: true,
    tabSize: preferences.tabSize,
    bracketPairColorization: { enabled: true },
    renderLineHighlight: 'gutter',
    ariaLabel: `Editor content for ${file.path}`,
  };
  const theme = editorThemeName(preferences.theme, preferences.pluginTheme);
  return (
    <>
      <div className="file-breadcrumb editor-toolbar">
        <span className="editor-file-path" title={file.path}>
          {file.path.replaceAll('/', ' / ')}
        </span>
        <div className="editor-actions" role="toolbar" aria-label="Editor actions">
          <button
            className="icon-button"
            aria-label="Undo"
            title="Undo • Ctrl+Z"
            disabled={!ready || !canUndo}
            onClick={() => run('undo')}
          >
            <Undo2 size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Redo"
            title="Redo • Ctrl+Y"
            disabled={!ready || !canRedo}
            onClick={() => run('redo')}
          >
            <Redo2 size={14} />
          </button>
          <span className="editor-action-divider" />
          <button
            className="icon-button"
            aria-label="Find in file"
            title="Find / replace • Ctrl+F / Ctrl+H"
            disabled={!ready}
            onClick={() => run('editor.action.startFindReplaceAction')}
          >
            <Search size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Format document"
            title={
              canFormat
                ? 'Format document • Shift+Alt+F'
                : 'No formatter available for this language'
            }
            disabled={!ready || !canFormat}
            onClick={() => run('editor.action.formatDocument')}
          >
            <ListFilter size={14} />
          </button>
          <button
            className={`icon-button ${preferences.wordWrap ? 'active' : ''}`}
            aria-label="Word wrap"
            aria-pressed={preferences.wordWrap}
            title="Toggle word wrap"
            onClick={onWrap}
          >
            <WrapText size={14} />
          </button>
          <span className="editor-action-divider" />
          {onAsk && (
            <button
              className="text-button"
              onClick={onAsk}
              title="Discuss this file or the selected code in chat"
            >
              <MessageSquare size={12} />
              <span>Ask chat</span>
            </button>
          )}
          <button
            className={`text-button editor-save ${dirty ? 'accent' : ''}`}
            disabled={busy || !dirty}
            onClick={() => onSave()}
            title="Save file • Ctrl+S"
          >
            {dirty ? <ArrowDownToLine size={12} /> : <Check size={12} />}
            <span>{busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</span>
          </button>
        </div>
      </div>
      {file.conflict && (
        <div className="conflict-banner" role="alert">
          <AlertCircle size={15} />
          <span>Changed on disk. Disk version on the left; your editable draft on the right.</span>
          <button disabled={busy} onClick={onUseDisk}>
            Use disk version
          </button>
          <button disabled={busy} onClick={() => onSave(true)}>
            Keep my edits
          </button>
        </div>
      )}
      <div className="monaco-container" role="tabpanel" aria-label={file.path}>
        {file.conflict ? (
          <DiffEditor
            key={`diff:${path}`}
            theme={theme}
            original={file.conflict.content.replace(/^\uFEFF/, '')}
            modified={file.content.replace(/^\uFEFF/, '')}
            originalModelPath={`${path}?disk`}
            modifiedModelPath={path}
            keepCurrentModifiedModel
            keepCurrentOriginalModel
            language={language(file.path)}
            options={{
              ...options,
              readOnly: false,
              originalEditable: false,
              renderSideBySide: true,
              // Disk resolution is handled by the explicit actions above.
              // The hunk menu also retains a disposed context in Monaco 0.56.
              renderGutterMenu: false,
            }}
            onMount={(editor) => mount(editor.getModifiedEditor(), true)}
            loading={<span className="muted inset editor-loading">Opening comparison…</span>}
          />
        ) : (
          <Editor
            key="code"
            theme={theme}
            path={path}
            language={language(file.path)}
            value={file.content.replace(/^\uFEFF/, '')}
            keepCurrentModel
            saveViewState
            onChange={(value) => onChange(editorContent(value ?? '', file.saved))}
            onMount={(editor) => mount(editor)}
            options={options}
            loading={<span className="muted inset editor-loading">Opening editor…</span>}
          />
        )}
      </div>
      <div className="editor-status" aria-label="Editor status">
        <span className={dirty ? 'accent' : ''}>
          {file.conflict ? 'Review disk changes' : dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <div>
          <button
            className="status-action"
            title="Go to line • Ctrl+G"
            onClick={() => run('editor.action.gotoLine')}
          >
            Ln {status.line}, Col {status.column}
            {status.selected > 0 ? ` (${status.selected} selected)` : ''}
          </button>
          <span>
            {status.spaces ? 'Spaces' : 'Tabs'}: {status.tabSize}
          </span>
          <span>UTF-8</span>
          <span>{status.eol}</span>
          <span>{language(file.path)}</span>
        </div>
      </div>
    </>
  );
}
