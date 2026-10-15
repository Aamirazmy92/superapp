// Chrome's keyboard shortcuts and right-click menu for pages in the built-in
// browser. Keys pressed inside a page never reach the app's window, so the
// main process watches them and hands browser commands to the renderer.

/**
 * The browser command a key press inside a page stands for, or null when the
 * page should receive it. `input` is Electron's before-input-event input.
 */
function browserShortcut(input) {
  if (!input || input.type !== 'keyDown') return null;
  const mod = input.control || input.meta;
  const { shift, alt } = input;
  const key = String(input.key);
  const lower = key.toLowerCase();
  if (key === 'F12' || (mod && shift && !alt && lower === 'i')) return 'devtools';
  if (key === 'F5' || (mod && !alt && lower === 'r'))
    return shift || (key === 'F5' && mod) ? 'hard-reload' : 'reload';
  if (key === 'F6' || (alt && !mod && lower === 'd')) return 'focus-address';
  if (alt && !mod && !shift && key === 'ArrowLeft') return 'back';
  if (alt && !mod && !shift && key === 'ArrowRight') return 'forward';
  if (mod && !alt && (key === 'Tab' || key === 'PageDown' || key === 'PageUp'))
    return (key === 'Tab' && shift) || key === 'PageUp' ? 'previous-tab' : 'next-tab';
  if (!mod || alt || shift) return null;
  if (lower === 't') return 'new-tab';
  if (lower === 'w') return 'close-tab';
  if (lower === 'l') return 'focus-address';
  if (lower === 'f') return 'find';
  if (lower === 'h') return 'history';
  return null;
}

const shorten = (text, length) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

/**
 * The right-click menu Chrome shows for this spot in a page, as an Electron
 * menu template. `params` is the context-menu event's params; `actions`
 * holds what each item does, so this stays free of Electron.
 */
function contextMenuTemplate(params, actions) {
  const sections = [];
  const flags = params.editFlags || {};
  const selection = String(params.selectionText || '').trim();
  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).slice(0, 5);
    sections.push([
      ...suggestions.map((word) => ({ label: word, click: () => actions.replaceMisspelling(word) })),
      ...(suggestions.length ? [] : [{ label: 'No spelling suggestions', enabled: false }]),
      { label: 'Add to dictionary', click: () => actions.addToDictionary(params.misspelledWord) },
    ]);
  }
  if (params.linkURL && actions.canOpen(params.linkURL)) {
    sections.push([
      { label: 'Open link in new tab', click: () => actions.openTab(params.linkURL) },
      { label: 'Copy link address', click: () => actions.copyText(params.linkURL) },
    ]);
  }
  if (params.mediaType === 'image' && params.srcURL) {
    sections.push([
      ...(actions.canOpen(params.srcURL)
        ? [{ label: 'Open image in new tab', click: () => actions.openTab(params.srcURL) }]
        : []),
      { label: 'Copy image', click: () => actions.copyImage() },
      { label: 'Copy image address', click: () => actions.copyText(params.srcURL) },
    ]);
  }
  if (params.isEditable) {
    sections.push([
      { label: 'Undo', role: 'undo', enabled: flags.canUndo !== false },
      { label: 'Redo', role: 'redo', enabled: flags.canRedo !== false },
    ]);
    sections.push([
      { label: 'Cut', role: 'cut', enabled: flags.canCut !== false },
      { label: 'Copy', role: 'copy', enabled: flags.canCopy !== false },
      { label: 'Paste', role: 'paste', enabled: flags.canPaste !== false },
      { label: 'Select all', role: 'selectAll', enabled: flags.canSelectAll !== false },
    ]);
  } else if (selection) {
    sections.push([{ label: 'Copy', role: 'copy' }]);
  }
  if (selection) {
    sections.push([
      { label: `Search Google for “${shorten(selection.replace(/\s+/g, ' '), 32)}”`, click: () => actions.search(selection) },
    ]);
  }
  if (!sections.length) {
    sections.push([
      { label: 'Back', enabled: actions.canGoBack(), click: () => actions.back() },
      { label: 'Forward', enabled: actions.canGoForward(), click: () => actions.forward() },
      { label: 'Reload', click: () => actions.reload() },
    ]);
    sections.push([{ label: 'Print…', click: () => actions.print() }]);
  }
  sections.push([{ label: 'Inspect', click: () => actions.inspect() }]);
  return sections.flatMap((items, index) => (index ? [{ type: 'separator' }, ...items] : items));
}

module.exports = { browserShortcut, contextMenuTemplate };
