// Element picker for the workspace browser: a script injected into the page
// that outlines the element under the cursor, and helpers that turn the
// element a user clicked into a prompt for a coding agent.

export const PICK_PREFIX = '__superapp_pick__';

export type ElementPick =
  | { type: 'pick'; element: PickedElement }
  | { type: 'cancel' };

export type PickedElement = {
  url: string;
  tag: string;
  selector: string;
  text: string;
  html: string;
  styles: Record<string, string>;
};

// Reads the page only; the one thing it writes is its own overlay. Messages
// reach the app through console.log with PICK_PREFIX.
export const PICKER_START_SCRIPT = `(() => {
  if (window.__superappPicker) window.__superappPicker.stop();
  const PREFIX = ${JSON.stringify(PICK_PREFIX)};
  const doc = document;
  const box = doc.createElement('div');
  const tag = doc.createElement('div');
  const style = doc.createElement('style');
  const mark = 'data-superapp-picker';
  for (const el of [box, tag, style]) el.setAttribute(mark, '');
  style.textContent = '*{cursor:crosshair !important}';
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;'
    + 'border:2px solid #4f8cff;background:rgba(79,140,255,.14);border-radius:2px;display:none';
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:11px/1.4 ui-monospace,Consolas,monospace;'
    + 'color:#fff;background:#2f6fe4;padding:2px 6px;border-radius:3px;white-space:nowrap;display:none';
  doc.documentElement.append(style, box, tag);
  let hovered = null;
  let chosen = null;
  const label = (el) => {
    let text = el.tagName.toLowerCase();
    if (el.id) text += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) text += '.' + cls.join('.');
    return text;
  };
  const place = (el) => {
    if (!el || !el.isConnected) { box.style.display = tag.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    box.style.display = tag.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    tag.textContent = label(el) + '  ' + Math.round(r.width) + '\\u00d7' + Math.round(r.height);
    tag.style.left = Math.max(0, Math.min(r.left, innerWidth - 160)) + 'px';
    tag.style.top = (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px';
  };
  const ours = (el) => !el || el.hasAttribute(mark);
  const selectorOf = (el) => {
    const part = (node) => {
      if (node.id && doc.querySelectorAll('#' + CSS.escape(node.id)).length === 1) return '#' + CSS.escape(node.id);
      let text = node.tagName.toLowerCase();
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\\s+/).filter((c) => c && c.length < 40).slice(0, 2) : [];
      for (const c of cls) text += '.' + CSS.escape(c);
      const parent = node.parentElement;
      if (parent && parent.querySelectorAll(':scope > ' + text).length > 1) {
        text += ':nth-child(' + (Array.prototype.indexOf.call(parent.children, node) + 1) + ')';
      }
      return text;
    };
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.documentElement) {
      parts.unshift(part(node));
      if (parts[0].startsWith('#')) break;
      let selector = parts.join(' > ');
      try { if (doc.querySelectorAll(selector).length === 1 && parts.length > 1) break; } catch {}
      node = node.parentElement;
      if (parts.length >= 5) break;
    }
    return parts.join(' > ');
  };
  const describe = (el) => {
    const cs = getComputedStyle(el);
    const styles = {};
    for (const name of ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin',
      'border', 'border-radius', 'display', 'width', 'height']) styles[name] = cs.getPropertyValue(name);
    const clone = el.cloneNode(true);
    clone.querySelectorAll && clone.querySelectorAll('script,style,svg').forEach((n) => n.remove());
    const html = clone.outerHTML || '';
    return {
      url: location.href,
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
      html: html.length > 700 ? html.slice(0, 700) + '\\u2026' : html,
      styles,
    };
  };
  const send = (message) => console.log(PREFIX + JSON.stringify(message));
  const swallow = (event) => {
    if (event.type === 'keydown' || ours(event.target)) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
  };
  const onMove = (event) => {
    if (chosen || ours(event.target)) return;
    hovered = event.target;
    place(hovered);
  };
  const onClick = (event) => {
    if (ours(event.target)) return;
    swallow(event);
    if (chosen) return;
    chosen = event.target;
    place(chosen);
    send({ type: 'pick', element: describe(chosen) });
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    send({ type: 'cancel' });
  };
  const reposition = () => place(chosen || hovered);
  const blocked = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'submit', 'auxclick'];
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  for (const type of blocked) doc.addEventListener(type, swallow, true);
  addEventListener('scroll', reposition, true);
  addEventListener('resize', reposition);
  window.__superappPicker = {
    // Clears the frozen selection so another element can be picked.
    reset() { chosen = null; hovered = null; place(null); },
    stop() {
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('keydown', onKey, true);
      for (const type of blocked) doc.removeEventListener(type, swallow, true);
      removeEventListener('scroll', reposition, true);
      removeEventListener('resize', reposition);
      box.remove(); tag.remove(); style.remove();
      delete window.__superappPicker;
    },
  };
})()`;

export const PICKER_STOP_SCRIPT = 'window.__superappPicker && window.__superappPicker.stop()';
export const PICKER_RESET_SCRIPT = 'window.__superappPicker && window.__superappPicker.reset()';

// Console output from the page: returns the picker message, or null for any
// other line (pages log plenty of their own).
export function parsePickMessage(text: string): ElementPick | null {
  if (!text.startsWith(PICK_PREFIX)) return null;
  try {
    const value = JSON.parse(text.slice(PICK_PREFIX.length));
    if (value?.type === 'cancel') return { type: 'cancel' };
    const element = value?.element;
    if (value?.type === 'pick' && element && typeof element.selector === 'string' && typeof element.tag === 'string') {
      const styles: Record<string, string> = {};
      for (const [name, style] of Object.entries(element.styles ?? {}))
        if (typeof style === 'string') styles[name] = style;
      return {
        type: 'pick',
        element: {
          url: String(element.url ?? ''),
          tag: element.tag,
          selector: element.selector,
          text: String(element.text ?? ''),
          html: String(element.html ?? ''),
          styles,
        },
      };
    }
  } catch {
    // Not ours after all.
  }
  return null;
}

export function buildPickPrompt(element: PickedElement, instruction: string): string {
  const styles = Object.entries(element.styles)
    .filter(([, value]) => value && value !== 'none' && value !== '0px')
    .map(([name, value]) => `${name}: ${value}`)
    .join('; ');
  const lines = [
    `In the page at ${element.url} I selected <${element.tag}>${element.text ? ` "${element.text.slice(0, 80)}"` : ''}.`,
    `Selector: ${element.selector}`,
  ];
  if (styles) lines.push(`Current styles: ${styles}`);
  if (element.html) lines.push(`HTML: ${element.html}`);
  lines.push('', `Change: ${instruction.trim()}`);
  return lines.join('\n');
}
