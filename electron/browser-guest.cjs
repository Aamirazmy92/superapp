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

/**
 * Whether `frame` (a WebFrameMain) sits behind a frame from another process,
 * such as an iframe from another site. webContents.inspectElement hit-tests
 * the top frame's process only, so there it would select the <iframe>.
 */
function inOtherProcess(frame) {
  for (let child = frame; child?.parent; child = child.parent)
    if (child.processId !== child.parent.processId) return true;
  return false;
}

/**
 * Runs inside the DevTools front end (serialised into executeJavaScript), so
 * it may use only its arguments. Starting from the top frame, it finds the
 * element at (x, y), in device pixels from the page view's top left, and
 * steps into each frame from another process that the point lands on, as
 * Chrome's Inspect does. Elements then shows the innermost element.
 * Resolves to its node name, or null when nothing is there.
 */
async function inspectNodeAt(x, y) {
  const SDK = await import('./core/sdk/sdk.js');
  const targets = SDK.TargetManager.TargetManager.instance();
  // DevTools has just opened, or has yet to attach a frame's process.
  const settle = async (find) => {
    for (let tries = 0; tries < 50; tries++) {
      const found = find();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };
  // Where a frame's layout viewport sits in its document, and (for the top
  // frame) how many device pixels a CSS pixel takes: page zoom shows up in
  // devicePixelRatio, or in the page scale under mobile emulation.
  const viewport = async (target) => {
    const { result } = await target.runtimeAgent().invoke_evaluate({
      expression: `(({ pageLeft, pageTop, offsetLeft, offsetTop, scale }) =>
        [pageLeft - offsetLeft, pageTop - offsetTop, offsetLeft, offsetTop, devicePixelRatio * scale])(visualViewport)`,
      returnByValue: true,
    });
    if (!Array.isArray(result?.value)) throw new Error('Could not read the page viewport.');
    return result.value;
  };
  let target = await settle(() => targets.primaryPageTarget());
  if (!target) return null;
  // From here (x, y) is in CSS pixels, relative to the frame's layout viewport.
  const [, , visualLeft, visualTop, pixels] = await viewport(target);
  x = visualLeft + x / pixels;
  y = visualTop + y / pixels;
  let found = null;
  for (let depth = 0; target && depth < 16; depth++) {
    const dom = target.domAgent();
    const [scrollLeft, scrollTop] = await viewport(target);
    const hit = await dom.invoke_getNodeForLocation({
      x: Math.round(scrollLeft + x),
      y: Math.round(scrollTop + y),
      ignorePointerEventsNone: true,
    });
    if (!hit.backendNodeId) break;
    const { node } = await dom.invoke_describeNode({ backendNodeId: hit.backendNodeId });
    found = { target, backendNodeId: hit.backendNodeId, name: node?.nodeName };
    // A frame owner whose document is in another process: carry on in that
    // process, relative to the frame's content box. (Frames in this process
    // are already searched by the hit test.)
    const resources = target.model(SDK.ResourceTreeModel.ResourceTreeModel);
    if (!node?.frameId || resources?.frameForId(node.frameId)) break;
    const child = await settle(() => targets.targetById(node.frameId));
    const { model } = child ? await dom.invoke_getBoxModel({ backendNodeId: hit.backendNodeId }) : {};
    if (!model) break;
    x -= model.content[0];
    y -= model.content[1];
    target = child;
  }
  if (!found) return null;
  found.target.model(SDK.OverlayModel.OverlayModel).inspectNodeRequested({ backendNodeId: found.backendNodeId });
  return found.name;
}

module.exports = { browserShortcut, contextMenuTemplate, inOtherProcess, inspectNodeAt };
