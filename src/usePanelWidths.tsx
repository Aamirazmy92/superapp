import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

// The explorer and the docked dashboard share the dock, the right-hand column. It is as wide as
// the explorer, or as the dashboard while that is in it, and dragging it resizes that panel.
export type ResizablePanel = 'projects' | 'explorer' | 'dashboard' | 'browser';
const panelLimits: Record<ResizablePanel, { min: number; max: number }> = {
  projects: { min: 160, max: 440 },
  explorer: { min: 170, max: 520 },
  dashboard: { min: 280, max: 760 },
  browser: { min: 280, max: 1000 },
};
const panelWidthKey = 'code-panel-widths';

function readPanelWidths(): Partial<Record<ResizablePanel, number>> {
  try {
    const saved = JSON.parse(localStorage.getItem(panelWidthKey) || '{}');
    if (!saved || typeof saved !== 'object') return {};
    return Object.fromEntries(
      (Object.keys(panelLimits) as ResizablePanel[])
        .filter((panel) => Number.isFinite(saved[panel]))
        .map((panel) => [
          panel,
          Math.max(panelLimits[panel].min, Math.min(panelLimits[panel].max, saved[panel])),
        ]),
    );
  } catch {
    return {};
  }
}

// Widths until the user drags them.
function defaultExplorerWidth() {
  return window.innerWidth <= 760 ? 180 : window.innerWidth <= 1100 ? 220 : 248;
}
function defaultDashboardWidth() {
  return Math.round(Math.max(340, Math.min(400, window.innerWidth * 0.28)));
}

/**
 * Widths of the resizable side panels (projects, the dock and the embedded
 * browser), remembered on this device, plus their drag separators.
 */
export function usePanelWidths({
  projectsPanelRef,
  dockRef,
  workspaceRef,
  workAreaRef,
}: {
  projectsPanelRef: RefObject<HTMLElement | null>;
  dockRef: RefObject<HTMLElement | null>;
  workspaceRef: RefObject<HTMLElement | null>;
  workAreaRef: RefObject<HTMLDivElement | null>;
}) {
  const panelDragRef = useRef<{
    panel: ResizablePanel;
    pointerId: number;
    startX: number;
    startWidth: number;
    minWidth: number;
    maxWidth: number;
    width: number;
    frame: number;
    separator: HTMLElement;
  } | null>(null);
  const [panelWidths, setPanelWidths] = useState(readPanelWidths);
  const explorerWidth = panelWidths.explorer ?? defaultExplorerWidth();
  const dashboardWidth = panelWidths.dashboard ?? defaultDashboardWidth();
  useEffect(() => {
    localStorage.setItem(panelWidthKey, JSON.stringify(panelWidths));
  }, [panelWidths]);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const browserContainerWidth =
    workAreaRef.current?.getBoundingClientRect().width || workspaceWidth;
  const browserPanelMaxWidth = Math.min(
    panelLimits.browser.max,
    Math.max(0, browserContainerWidth - 326),
  );
  const browserPanelMinWidth = Math.min(panelLimits.browser.min, browserPanelMaxWidth);
  const browserPanelWidth = Math.round(
    Math.max(
      browserPanelMinWidth,
      Math.min(browserPanelMaxWidth, panelWidths.browser ?? browserContainerWidth * 0.48),
    ),
  );
  // Until the user drags it, the browser takes about half the work area. That is stated in CSS,
  // against the work area's live width, so it follows a panel sliding in or out frame by frame
  // instead of snapping once the measured width settles.
  const browserPanelSize =
    panelWidths.browser == null
      ? {
          width: `max(min(${panelLimits.browser.min}px, 100% - 326px), min(48%, ${panelLimits.browser.max}px, 100% - 326px))`,
          minWidth: `min(${panelLimits.browser.min}px, 100% - 326px)`,
        }
      : { width: browserPanelWidth, minWidth: browserPanelMinWidth };
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      if (document.body.classList.contains('dashboard-layout-transitioning')) return;
      const width = workspace.getBoundingClientRect().width;
      // Zero means the code view is hidden (chat mode), not that it shrank. Keeping
      // the last width stops the terminal grid collapsing to one column meanwhile,
      // which on return flashed that layout and refit every CLI to it for a frame.
      if (width) setWorkspaceWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    window.addEventListener('dashboard-layout-settled', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('dashboard-layout-settled', measure);
    };
  }, []);
  function panelElement(panel: ResizablePanel): HTMLElement | null {
    if (panel === 'projects') return projectsPanelRef.current;
    if (panel === 'explorer' || panel === 'dashboard') return dockRef.current;
    return workAreaRef.current?.querySelector('.workspace-browser') ?? null;
  }
  // A panel grabbed mid-reveal jumps to its final width first, so resizing
  // starts from it and the reveal cannot overwrite the new width.
  function settledPanelWidth(panel: ResizablePanel) {
    const element = panelElement(panel);
    element?.getAnimations().forEach((animation) => animation.finish());
    return element?.getBoundingClientRect().width;
  }
  function panelMinWidth(panel: ResizablePanel) {
    return panel === 'browser' ? browserPanelMinWidth : panelLimits[panel].min;
  }
  function panelMaxWidth(panel: ResizablePanel, currentWidth: number) {
    // Measured now rather than from the last settled layout, which the browser's own CSS width
    // no longer waits for.
    if (panel === 'browser') {
      const live = workAreaRef.current?.getBoundingClientRect().width;
      return live ? Math.min(panelLimits.browser.max, Math.max(0, live - 326)) : browserPanelMaxWidth;
    }
    const mainWidth = workspaceRef.current?.getBoundingClientRect().width || 0;
    return Math.max(
      panelLimits[panel].min,
      Math.min(panelLimits[panel].max, currentWidth + mainWidth - 320),
    );
  }
  function setPanelWidth(panel: ResizablePanel, width: number, maxWidth: number) {
    const next = Math.round(Math.max(panelMinWidth(panel), Math.min(maxWidth, width)));
    setPanelWidths((current) =>
      current[panel] === next ? current : { ...current, [panel]: next },
    );
  }
  function startPanelResize(panel: ResizablePanel, event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const width = settledPanelWidth(panel);
    if (width === undefined) return;
    panelDragRef.current = {
      panel,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      minWidth: panelMinWidth(panel),
      maxWidth: panelMaxWidth(panel, width),
      width: Math.round(width),
      frame: 0,
      separator: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('panel-resizing');
    event.preventDefault();
  }
  // Dragging writes widths straight to the DOM once per frame and commits to
  // state on release, so the app does not re-render on every pointer move.
  function applyPanelWidth(panel: ResizablePanel, width: number) {
    const element = panelElement(panel);
    if (!element) return;
    element.style.width = `${width}px`;
    element.style.flexBasis = `${width}px`;
  }
  function movePanelResize(event: React.PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    // The dock and browser sit on the right, so dragging left widens them.
    const direction = drag.panel === 'projects' ? 1 : -1;
    const raw = drag.startWidth + (event.clientX - drag.startX) * direction;
    drag.width = Math.round(Math.max(drag.minWidth, Math.min(drag.maxWidth, raw)));
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      applyPanelWidth(drag.panel, drag.width);
      drag.separator.setAttribute('aria-valuenow', String(drag.width));
    });
  }
  function endPanelResize(event: React.PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    panelDragRef.current = null;
    cancelAnimationFrame(drag.frame);
    applyPanelWidth(drag.panel, drag.width);
    setPanelWidth(drag.panel, drag.width, drag.maxWidth);
    document.body.classList.remove('panel-resizing');
  }
  function resizePanelWithKeyboard(
    panel: ResizablePanel,
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const width = settledPanelWidth(panel);
    if (width === undefined) return;
    event.preventDefault();
    const maxWidth = panelMaxWidth(panel, width);
    const direction = panel === 'projects' ? 1 : -1;
    const step = event.shiftKey ? 48 : 16;
    const next =
      event.key === 'Home'
        ? panelMinWidth(panel)
        : event.key === 'End'
          ? maxWidth
          : width + (event.key === 'ArrowRight' ? step : -step) * direction;
    setPanelWidth(panel, next, maxWidth);
  }
  function panelSeparator(panel: ResizablePanel, label: string) {
    const fallback =
      panel === 'projects'
        ? window.innerWidth <= 760 ? 170 : window.innerWidth <= 1100 ? 214 : 244
        : panel === 'explorer'
          ? explorerWidth
          : panel === 'dashboard'
            ? dashboardWidth
            : browserPanelWidth;
    return (
      <div
        className={`panel-separator panel-separator-${panel}`}
        role="separator"
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={panelMinWidth(panel)}
        aria-valuemax={panelMaxWidth(panel, fallback)}
        aria-valuenow={
          panel === 'browser'
            ? browserPanelWidth
            : Math.round(panelWidths[panel] ?? fallback)
        }
        tabIndex={0}
        onPointerDown={(event) => startPanelResize(panel, event)}
        onPointerMove={movePanelResize}
        onPointerUp={endPanelResize}
        onPointerCancel={endPanelResize}
        onLostPointerCapture={endPanelResize}
        onKeyDown={(event) => resizePanelWithKeyboard(panel, event)}
      />
    );
  }
  return {
    panelWidths,
    explorerWidth,
    dashboardWidth,
    browserContainerWidth,
    browserPanelWidth,
    browserPanelMinWidth,
    browserPanelSize,
    panelSeparator,
  };
}
