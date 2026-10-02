import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { moveToSlotOf, paneAtPoint } from './terminalReorder';
import type { PaneBox } from './terminalReorder';

const DRAG_THRESHOLD = 5;
const SETTLE_MS = 180;
const SETTLE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

type Session = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  grabX: number;
  grabY: number;
  active: boolean;
};

/**
 * Pointer-driven terminal reordering. The dragged pane follows the cursor while the others
 * reflow live into the order it would land in; releasing commits it, Escape cancels.
 * Panes keep their React keys throughout, so no terminal is remounted.
 */
export function useTerminalReorder({
  gridRef,
  ids,
  enabled,
  onCommit,
}: {
  gridRef: RefObject<HTMLElement | null>;
  ids: string[];
  enabled: boolean;
  onCommit(ids: string[]): void;
}) {
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const orderRef = useRef<string[] | null>(null);
  const beforeRects = useRef<Map<string, DOMRect> | null>(null);
  const homing = useRef<string | null>(null);
  // Layout boxes ignore transforms, so they only change when the order or grid size does.
  const boxes = useRef<PaneBox[]>([]);
  const frame = useRef(0);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const latest = useRef({ ids, onCommit });
  latest.current = { ids, onCommit };

  const panes = () =>
    [...(gridRef.current?.querySelectorAll<HTMLElement>(':scope > .terminal-pane') ?? [])];
  const paneId = (pane: HTMLElement) => pane.id.replace(/^terminal-/, '');
  const paneFor = (id: string) => panes().find((pane) => paneId(pane) === id);

  const applyOrder = (next: string[] | null) => {
    beforeRects.current = new Map(
      panes().map((pane) => [paneId(pane), pane.getBoundingClientRect()]),
    );
    orderRef.current = next;
    setOrder(next);
  };

  const measure = () => {
    boxes.current = panes().map((pane) => ({
      id: paneId(pane),
      left: pane.offsetLeft,
      top: pane.offsetTop,
      width: pane.offsetWidth,
      height: pane.offsetHeight,
    }));
  };

  // The pointer in the grid's scrolled content space, where the cached boxes live.
  const contentPoint = (s: Session) => {
    const grid = gridRef.current!;
    const rect = grid.getBoundingClientRect();
    return {
      x: s.pointerX - rect.left - grid.clientLeft + grid.scrollLeft,
      y: s.pointerY - rect.top - grid.clientTop + grid.scrollTop,
    };
  };

  // Keeps the dragged pane under the cursor. Uses cached boxes, so it never forces layout.
  const follow = () => {
    const s = session.current;
    if (!s || !gridRef.current) return;
    const box = boxes.current.find((b) => b.id === s.id);
    const pane = paneFor(s.id);
    if (!box || !pane) return;
    const point = contentPoint(s);
    pane.style.transition = 'none';
    pane.style.transform = `translate(${point.x - s.grabX - box.left}px, ${point.y - s.grabY - box.top}px)`;
  };

  // Runs at most once per frame, however fast pointer events arrive.
  const tick = () => {
    frame.current = 0;
    const s = session.current;
    if (!s?.active || !gridRef.current) return;
    const point = contentPoint(s);
    const target = paneAtPoint(boxes.current, point.x, point.y, s.id);
    follow();
    if (!target) return;
    const current = orderRef.current ?? latest.current.ids;
    const next = moveToSlotOf(current, s.id, target);
    if (next !== current) applyOrder(next);
  };

  // FLIP: after the order changes, slide every other pane from where it was to where it is.
  useLayoutEffect(() => {
    const before = beforeRects.current;
    beforeRects.current = null;
    const s = session.current;
    if (!before && !s?.active) return;
    const moves: HTMLElement[] = [];
    for (const pane of panes()) {
      const id = paneId(pane);
      if (id === homing.current) continue;
      pane.style.transition = 'none';
      pane.style.transform = '';
      if (s?.active && s.id === id) continue;
      const from = before?.get(id);
      if (!from) continue;
      const to = pane.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx || dy) {
        pane.style.transform = `translate(${dx}px, ${dy}px)`;
        moves.push(pane);
      }
    }
    if (s?.active) {
      measure();
      follow();
    }
    if (!moves.length) return;
    void gridRef.current?.offsetWidth;
    for (const pane of moves) {
      pane.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASING}`;
      pane.style.transform = '';
    }
  }, [order, draggingId]);

  // The drag is tracked on window, not on the header. React reorders panes by moving their
  // DOM nodes, and Chromium drops pointer capture from a moved element, so a captured drag
  // froze after the first live swap. Listener identities are stable across renders.
  const handlers = useRef({
    move: (_event: PointerEvent) => {},
    end: (_commit: boolean) => {},
  });
  const windowListeners = useRef({
    pointermove: (event: PointerEvent) => handlers.current.move(event),
    pointerup: (event: PointerEvent) => {
      if (event.pointerId === session.current?.pointerId) handlers.current.end(true);
    },
    pointercancel: (event: PointerEvent) => {
      if (event.pointerId === session.current?.pointerId) handlers.current.end(false);
    },
    keydown: (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      handlers.current.end(false);
    },
    blur: () => handlers.current.end(false),
  }).current;
  const listen = (on: boolean) => {
    const method = on ? 'addEventListener' : 'removeEventListener';
    for (const [type, listener, capture] of [
      ['pointermove', windowListeners.pointermove, true],
      ['pointerup', windowListeners.pointerup, true],
      ['pointercancel', windowListeners.pointercancel, true],
      ['keydown', windowListeners.keydown, true],
      ['blur', windowListeners.blur, false],
    ] as const)
      window[method](type, listener as EventListener, capture);
  };
  const teardown = () => {
    listen(false);
    document.body.classList.remove('terminal-reordering');
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    resizeObserver.current?.disconnect();
    resizeObserver.current = null;
  };

  const finish = (commit: boolean) => {
    const s = session.current;
    session.current = null;
    teardown();
    if (!s?.active) return;
    const final = orderRef.current;
    const pane = paneFor(s.id);
    if (pane) {
      homing.current = s.id;
      pane.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASING}`;
      pane.style.transform = '';
      window.setTimeout(() => {
        if (homing.current === s.id) homing.current = null;
        pane.style.transition = '';
      }, SETTLE_MS + 40);
    }
    if (commit) {
      beforeRects.current = null;
      orderRef.current = null;
      if (final) latest.current.onCommit(final);
      setOrder(null);
    } else {
      applyOrder(null);
    }
    setDraggingId(null);
  };

  const move = (event: PointerEvent) => {
    const s = session.current;
    if (!s || event.pointerId !== s.pointerId) return;
    s.pointerX = event.clientX;
    s.pointerY = event.clientY;
    // The button came up somewhere we never heard about: drop rather than stay stuck.
    if (event.buttons === 0) {
      finish(s.active);
      return;
    }
    if (!s.active) {
      if (Math.hypot(s.pointerX - s.startX, s.pointerY - s.startY) < DRAG_THRESHOLD) return;
      measure();
      const box = boxes.current.find((b) => b.id === s.id);
      if (!box || !gridRef.current) return;
      const point = contentPoint({ ...s, pointerX: s.startX, pointerY: s.startY });
      s.grabX = point.x - box.left;
      s.grabY = point.y - box.top;
      s.active = true;
      // A webview swallows pointer events that pass over it.
      document.body.classList.add('terminal-reordering');
      resizeObserver.current = new ResizeObserver(() => {
        measure();
        follow();
      });
      resizeObserver.current.observe(gridRef.current);
      setDraggingId(s.id);
      return;
    }
    if (!frame.current) frame.current = requestAnimationFrame(tick);
  };
  handlers.current = { move, end: finish };
  useEffect(() => teardown, []);

  const headerProps = (id: string) => ({
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (
        !enabled ||
        event.button !== 0 ||
        (event.target as HTMLElement).closest('.terminal-pane-actions')
      )
        return;
      if (session.current) finish(false);
      session.current = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        pointerX: event.clientX,
        pointerY: event.clientY,
        grabX: 0,
        grabY: 0,
        active: false,
      };
      listen(true);
    },
  });

  return { order, draggingId, headerProps };
}
