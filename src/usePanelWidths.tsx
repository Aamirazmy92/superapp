import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { MotionValue } from 'motion/react';

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

/**
 * Widths of the resizable side panels (projects, explorer, dashboard drawer and
 * embedded browser), remembered on this device, plus their drag separators.
 */
export function usePanelWidths({
  projectsPanelRef,
  explorerPanelRef,
  workspaceRef,
  workAreaRef,
  dashboardDrawerMotionWidth,
  onDashboardResizeStart,
}: {
  projectsPanelRef: RefObject<HTMLElement | null>;
  explorerPanelRef: RefObject<HTMLElement | null>;
  workspaceRef: RefObject<HTMLElement | null>;
  workAreaRef: RefObject<HTMLDivElement | null>;
  dashboardDrawerMotionWidth: MotionValue<number>;
  onDashboardResizeStart(): void;
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
  const dashboardPanelWidth = Math.round(
    panelWidths.dashboard ?? Math.max(340, Math.min(400, window.innerWidth * 0.28)),
  );
  const dashboardDrawerWidth = dashboardPanelWidth + 6;
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
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => {
      if (document.body.classList.contains('dashboard-layout-transitioning')) return;
      setWorkspaceWidth(workspace.getBoundingClientRect().width);
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
    if (panel === 'explorer') return explorerPanelRef.current;
    if (panel === 'dashboard') return document.getElementById('agent-dashboard');
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
    if (panel === 'browser') return browserPanelMaxWidth;
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
    // Grabbing the drawer mid-animation stops that animation, so settle now.
    if (panel === 'dashboard') onDashboardResizeStart();
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
    if (panel === 'dashboard') {
      const appBody = workspaceRef.current?.closest<HTMLElement>('.app-body');
      appBody?.style.setProperty('--dashboard-width', `${width}px`);
      // Keep the drawer's motion value in step with the DOM; otherwise the
      // animation still holds the old width and snaps back to it on release.
      dashboardDrawerMotionWidth.jump(width + 6);
      const drawer = appBody?.querySelector<HTMLElement>('.dashboard-drawer.docked');
      if (drawer) drawer.style.width = `${width + 6}px`;
      return;
    }
    const element = panelElement(panel);
    if (!element) return;
    element.style.width = `${width}px`;
    element.style.flexBasis = `${width}px`;
  }
  function movePanelResize(event: React.PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const direction = drag.panel === 'dashboard' || drag.panel === 'browser' ? -1 : 1;
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
    const direction = panel === 'dashboard' || panel === 'browser' ? -1 : 1;
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
          ? window.innerWidth <= 760 ? 180 : window.innerWidth <= 1100 ? 220 : 248
          : panel === 'dashboard'
            ? Math.max(340, Math.min(400, window.innerWidth * 0.28))
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
    dashboardDrawerWidth,
    browserContainerWidth,
    browserPanelWidth,
    browserPanelMinWidth,
    panelSeparator,
  };
}
