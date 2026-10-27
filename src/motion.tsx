import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import {
  animate,
  motion,
  useIsPresent,
  type HTMLMotionProps,
  type Transition,
} from 'motion/react';

/*
 * One motion language for the whole app.
 *
 * Every floating surface (menu, dialog, toast) is two layers: the panel behind
 * it (background, border, shadow) grows slightly from its anchor, while the element
 * holding the text only fades. Text is therefore always drawn in its final
 * position and never slides, scales or re-rasterises.
 *
 * The CSS side uses the same curve and durations via --ease-out / --dur-*.
 */
/* Surfaces are readable within ~100ms, settle smoothly by ~300ms and close
   faster than they open with an accelerating fade. Same curve as --ease in
   design.css. */
const easeOut = [0.16, 1, 0.3, 1] as const;
const easeIn = [0.4, 0, 1, 1] as const;
const easeInOut = [0.4, 0, 0.2, 1] as const;

export const springs = {
  press: { duration: 0.08, ease: easeOut },
  release: { duration: 0.14, ease: easeOut },
} satisfies Record<string, Transition>;

export const fade = {
  in: { duration: 0.09, ease: easeOut },
  out: { duration: 0.08, ease: easeInOut },
} as const;

type Kind = 'popover' | 'dialog' | 'toast';

/*
 * One motion for every floating surface: dialogs, menus, popovers and toasts.
 * Tweak the feel here, in one place.
 * Open ~120ms: the backdrop leads by 15ms, then the card fades and scales 0.96 -> 1.
 * Close ~80ms, quicker than open: card fades and scales to 0.97 while the backdrop
 * fades in parallel. No slide. Dialogs scale from the centre; menus and popovers
 * from the corner of their trigger (their transform-origin).
 */
export const modalTiming = {
  openMs: 120,
  closeMs: 160,
  backdropOpenMs: 100,
  cardDelayMs: 15,
  openFrom: 0.96,
  closeTo: 0.97,
  openEase: [0.16, 1, 0.3, 1] as const,
  closeEase: [0.4, 0, 0.2, 1] as const,
};

const ms = (value: number) => value / 1000;

function modalCardMotion(interactive: boolean) {
  const t = modalTiming;
  return {
    initial: { opacity: 0, scale: t.openFrom },
    animate: {
      opacity: 1,
      scale: 1,
      ...(interactive ? { pointerEvents: 'auto' } : null),
      transition: { duration: ms(t.openMs), delay: ms(t.cardDelayMs), ease: t.openEase },
    },
    exit: {
      opacity: 0,
      scale: t.closeTo,
      ...(interactive ? { pointerEvents: 'none' } : null),
      transition: { duration: ms(t.closeMs), ease: t.closeEase },
    },
  } as HTMLMotionProps<'div'>;
}

const modalBackdropMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: ms(modalTiming.backdropOpenMs), ease: easeOut } },
  exit: { opacity: 0, transition: { duration: ms(modalTiming.closeMs), ease: easeIn } },
} satisfies HTMLMotionProps<'div'>;

/* Reduced motion for modals: no scale, just a short opacity fade. */
const modalReducedMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1, pointerEvents: 'auto', transition: { duration: ms(modalTiming.closeMs), ease: 'linear' } },
  exit: { opacity: 0, pointerEvents: 'none', transition: { duration: ms(modalTiming.closeMs), ease: 'linear' } },
} satisfies HTMLMotionProps<'div'>;

const modalCardInteractive = modalCardMotion(true);
const modalCardPanel = modalCardMotion(false);

/** Hints the compositor only while a modal animates, then lets go. */
function useWillChange<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  return {
    ref,
    onAnimationStart: () => {
      if (ref.current) ref.current.style.willChange = 'transform, opacity';
    },
    onAnimationComplete: () => {
      if (ref.current) ref.current.style.willChange = '';
    },
  };
}

/** For the element holding a floating surface's content: it scales and fades with its panel. */
export function surfaceMotion(_kind: Kind = 'popover') {
  return motionReduced() ? modalReducedMotion : modalCardInteractive;
}

function panelMotionProps(_kind: Kind) {
  return motionReduced() ? modalReducedMotion : modalCardPanel;
}

/**
 * A surface that is fading out is already closed: it must not take clicks or
 * focus, and code looking for an open dialog or menu must skip it. `inert`
 * gives the first two; `[inert]` is what the rest checks for (see isClosing).
 */
export function useClosingProps() {
  const present = useIsPresent();
  return present ? {} : { inert: true, 'data-closing': '' };
}

/**
 * A motion.div that goes inert while it animates out. Needed when the surface
 * is rendered inline under AnimatePresence: an exiting child keeps the props it
 * last had, so the parent cannot pass "closing" down itself.
 */
export function PresenceDiv(props: HTMLMotionProps<'div'>) {
  return <motion.div {...props} {...useClosingProps()} />;
}

/** Whether an element belongs to a surface that is animating out. */
export function isClosing(element: Element) {
  return !!element.closest('[inert], [data-closing]');
}

export function fadeMotion() {
  return motionReduced()
    ? {
        initial: false,
        animate: { opacity: 1, pointerEvents: 'auto' as const, transition: { duration: 0 } },
        exit: { opacity: 1, pointerEvents: 'none' as const, transition: { duration: 0 } },
      }
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1, pointerEvents: 'auto' as const, transition: fade.in },
        exit: { opacity: 0, pointerEvents: 'none' as const, transition: fade.out },
      };
}

type SurfaceRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: string;
  origin: string;
};

/** The animated panel. Absolutely positioned; `rect` overrides the default inset. */
export function Surface({
  kind = 'popover',
  origin,
  rect,
  animateSurface = true,
}: {
  kind?: Kind;
  origin?: string;
  rect?: SurfaceRect;
  animateSurface?: boolean;
}) {
  const hint = useWillChange<HTMLSpanElement>();
  return (
    <motion.span
      ref={hint.ref}
      onAnimationStart={hint.onAnimationStart}
      onAnimationComplete={hint.onAnimationComplete}
      aria-hidden="true"
      className={`motion-surface motion-surface-${kind}`}
      style={{
        ...(rect
          ? {
              inset: 'auto',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              borderRadius: rect.radius,
              transformOrigin: rect.origin,
            }
          : null),
        ...(origin ? { transformOrigin: origin } : null),
      }}
      {...(animateSurface ? panelMotionProps(kind) : {})}
    />
  );
}

export const PopoverSurface = Surface;

/**
 * Keeps showing what a surface held when it began closing. Choosing an item
 * often changes the state the menu renders from ("Show files" → "Hide files"),
 * and that text must not swap while the menu fades out.
 */
export function FreezeOnExit({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const shown = useRef(children);
  if (present) shown.current = children;
  return <>{shown.current}</>;
}

type DialogTag = 'div' | 'section' | 'form';

/**
 * A dialog whose panel springs behind it. The panel is a sibling (dialogs clip
 * and scroll their own content), kept exactly over the dialog as it resizes.
 */
export function MotionDialog({
  as = 'div',
  dialogRef,
  className = '',
  smoothHeight = false,
  children,
  ...props
}: Omit<HTMLMotionProps<'div'>, 'ref' | 'children'> & {
  as?: DialogTag;
  dialogRef?: Ref<HTMLElement>;
  /** Ease between heights as results change. For top-anchored dialogs only. */
  smoothHeight?: boolean;
  children?: ReactNode;
}) {
  const local = useRef<HTMLElement | null>(null);
  const [rect, setRect] = useState<SurfaceRect | null>(null);
  const present = useIsPresent();
  const wasPresent = useRef(present);

  /*
   * Reopened while still fading out, the dialog is the same element brought
   * back rather than a new one, so autoFocus does not run again; and focus left
   * it when it closed (it went inert). Put focus back where an opening puts it.
   */
  useEffect(() => {
    const reopened = present && !wasPresent.current;
    wasPresent.current = present;
    const element = local.current;
    if (!reopened || !element) return;
    (
      element.querySelector<HTMLElement>('input, textarea, select') ||
      element.querySelector<HTMLElement>('button')
    )?.focus();
  }, [present]);

  useLayoutEffect(() => {
    const element = local.current;
    if (!smoothHeight || !element) return;
    /*
     * The dialog's children keep their natural size whatever height the dialog
     * is animating through, so watching them reveals every content change.
     * Dialog and panel get identical animations in the same callback: the
     * panel's React-driven rect would otherwise trail by a frame and let
     * content show past its edge. No fill, so nothing is left behind.
     */
    let settled = element.offsetHeight;
    let running: Animation[] = [];
    const observer = new ResizeObserver(() => {
      const from = running.length ? element.getBoundingClientRect().height : settled;
      running.forEach((animation) => animation.cancel());
      running = [];
      const to = element.offsetHeight;
      settled = to;
      if (Math.abs(to - from) < 1 || motionReduced()) return;
      const panel = element.previousElementSibling;
      const keyframes = { height: [`${from}px`, `${to}px`] };
      const timing = { duration: 180, easing: easeOutCss };
      running = [element, panel instanceof HTMLElement && panel.matches('.motion-surface') ? panel : null]
        .filter((node): node is HTMLElement => !!node)
        .map((node) => node.animate(keyframes, timing));
    });
    for (const child of element.children) observer.observe(child);
    return () => {
      observer.disconnect();
      running.forEach((animation) => animation.cancel());
    };
  }, [smoothHeight]);

  useLayoutEffect(() => {
    const element = local.current;
    if (!element) return;
    /* Layout box, not getBoundingClientRect: the dialog is mid-scale while opening. */
    const measure = () => {
      const style = getComputedStyle(element);
      setRect({
        left: element.offsetLeft,
        top: element.offsetTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
        radius: style.borderRadius,
        origin: style.transformOrigin,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const setRef = (node: HTMLElement | null) => {
    local.current = node;
    if (typeof dialogRef === 'function') dialogRef(node);
    else if (dialogRef) (dialogRef as RefObject<HTMLElement | null>).current = node;
  };
  const closing = useClosingProps();
  const modalHint = {
    onAnimationStart: () => {
      if (local.current) local.current.style.willChange = 'transform, opacity';
    },
    onAnimationComplete: () => {
      if (local.current) local.current.style.willChange = '';
    },
  };
  const Tag = as === 'section' ? motion.section : as === 'form' ? motion.form : motion.div;
  return (
    <>
      {rect && <Surface kind="dialog" rect={rect} />}
      <Tag
        {...(surfaceMotion('dialog') as object)}
        {...modalHint}
        {...closing}
        {...(props as object)}
        ref={setRef as never}
        className={`${className} has-motion-surface`}
      >
        <FreezeOnExit>{children}</FreezeOnExit>
      </Tag>
    </>
  );
}

export function Backdrop({ onMouseDown, onClick, ...props }: HTMLMotionProps<'div'>) {
  const present = useIsPresent();
  /* Not inert while it fades out: an inert scrim would let clicks fall through to the
     page behind. It keeps catching them, and ignores them, until it is gone. */
  return (
    <motion.div
      {...(motionReduced() ? modalReducedMotion : modalBackdropMotion)}
      {...props}
      {...(present ? null : { 'data-closing': '' })}
      onMouseDown={present ? onMouseDown : undefined}
      onClick={present ? onClick : undefined}
    />
  );
}

/** Set from Settings → Appearance; also covers CSS via the `reduce-motion` class. */
export function motionReduced() {
  return document.documentElement.classList.contains('reduce-motion');
}

/**
 * For a menu with no separate panel (its box is also its scroll container):
 * slide it the last few pixels out of its trigger as it fades in. Uses the
 * `translate` property so it composes with Motion's transform, and no fill.
 */
export function dropIn(element: HTMLElement, downward: boolean) {
  if (motionReduced()) return;
  element.animate(
    { translate: [`0 ${downward ? -5 : 5}px`, '0 0'] },
    { duration: 260, easing: easeOutCss },
  );
}

/** Show the requested view in the same commit, then animate its arrival. */
export function useViewSwitch<T extends string>(
  view: T,
  order: readonly T[],
  element: (view: T) => HTMLElement | null,
) {
  const previous = useRef(view);
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = view;
    if (from === view || motionReduced()) return;
    const next = element(view);
    if (!next) return;
    const direction = order.indexOf(view) > order.indexOf(from) ? 1 : -1;
    const offset = direction * 7;
    const animation = next.animate(
      { opacity: [0.7, 1], transform: [`translateX(${offset}px)`, 'none'] },
      { duration: 140, easing: easeOutCss },
    );
    return () => animation.cancel();
  }, [view]);
  return view;
}

/*
 * Whole-view reveals use the Web Animations API without `fill`, so nothing is
 * left in inline styles when they end. (Motion's animate() re-commits its final
 * keyframe after completing; a leftover transform, even translateX(0), makes
 * the view a containing block for its position: fixed children.)
 */
const easeOutCss = `cubic-bezier(${easeOut.join(', ')})`;

/* Panels slide and stacked panes resize over the same time and curve. */
const panelMs = 220;

/*
 * While any panel animates, terminals keep their size and refit once, when the last motion
 * settles (see TerminalPane). Each motion takes a hold and releases it when it ends.
 */
let layoutHolds = 0;
export function holdPanelLayout() {
  layoutHolds++;
  document.body.classList.add('dashboard-layout-transitioning');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--layoutHolds) return;
    document.body.classList.remove('dashboard-layout-transitioning');
    window.dispatchEvent(new Event('dashboard-layout-settled'));
  };
}

type SlideState = { offset: number; opacity: number };
type Slide = {
  animation: Animation;
  restingMargin: number;
};

/** Which edge a docked panel sits against: its resize separator is on the other side. */
export type PanelAnchor = 'start' | 'end';

function panelSeparator(panel: HTMLElement, anchor: PanelAnchor) {
  const sibling = anchor === 'start' ? panel.nextElementSibling : panel.previousElementSibling;
  return sibling instanceof HTMLElement && sibling.classList.contains('panel-separator')
    ? sibling
    : null;
}

// The margin on the panel's inner side, which the slide pulls negative.
function innerMargin(anchor: PanelAnchor) {
  return anchor === 'start' ? 'marginRight' : 'marginLeft';
}

/*
 * Slides a docked panel (and the resize separator beside it) out of the layout
 * by `offset` px. The panel keeps its width, so its rows never reflow: a
 * negative margin on its inner side lets the neighbouring layout grow over it,
 * and a matching clip hides exactly the part that would be overlapped.
 * Terminals hold their grid until the slide settles, as they do for the
 * dashboard drawer.
 */
function slidePanel(
  panel: HTMLElement,
  anchor: PanelAnchor,
  restingMargin: number,
  from: SlideState,
  to: SlideState,
  onFinish?: () => void,
): Slide {
  const release = holdPanelLayout();
  const clip = (offset: number) =>
    anchor === 'start' ? `inset(0 ${offset}px 0 0)` : `inset(0 0 0 ${offset}px)`;
  const animation = panel.animate(
    {
      [innerMargin(anchor)]: [
        `${restingMargin - from.offset}px`,
        `${restingMargin - to.offset}px`,
      ],
      clipPath: [clip(from.offset), clip(to.offset)],
      opacity: [from.opacity, to.opacity],
    },
    { duration: panelMs, easing: easeOutCss },
  );
  const slide: Slide = { animation, restingMargin };
  let finished = false;
  const done = (completed: boolean) => {
    if (finished) return;
    finished = true;
    // Runs before the next frame, so a closed panel never flashes back in
    // between the animation ending and React hiding it.
    if (completed) onFinish?.();
    release();
  };
  animation.addEventListener('finish', () => done(true));
  animation.addEventListener('cancel', () => done(false));
  return slide;
}

/** Lets terminals fit to the layout `arrange` produces, then undoes it before paint. */
function previewLayout(arrange: () => () => void) {
  const restore = arrange();
  try {
    window.dispatchEvent(new Event('dashboard-layout-preview'));
  } finally {
    restore();
  }
}

/**
 * Show and hide a docked side panel with the dashboard drawer's motion, sliding
 * it in and out the same way. Returns whether the panel should be hidden
 * (display: none or unmounted); a closing panel stays shown until it has slid
 * away, and toggling mid-slide turns around from where it is. `instant` skips
 * the motion, for a panel that is not docked at the moment.
 */
export function useCollapse(
  element: () => HTMLElement | null,
  open: boolean,
  { anchor = 'start', instant = false }: { anchor?: PanelAnchor; instant?: boolean } = {},
) {
  const shown = useRef(open);
  const [hidden, setHidden] = useState(!open);
  const slide = useRef<Slide | null>(null);
  const revealPending = useRef(false);
  // Where the running slide is, stopping it; null state when nothing runs.
  function stopSlide(panel: HTMLElement) {
    const running = slide.current;
    slide.current = null;
    if (!running) {
      const restingMargin = parseFloat(getComputedStyle(panel)[innerMargin(anchor)]) || 0;
      return { restingMargin, state: null };
    }
    const style = getComputedStyle(panel);
    const state = {
      offset: running.restingMargin - (parseFloat(style[innerMargin(anchor)]) || 0),
      opacity: parseFloat(style.opacity),
    };
    running.animation.cancel();
    return { restingMargin: running.restingMargin, state };
  }
  function slideDistance(panel: HTMLElement) {
    const separator = panelSeparator(panel, anchor);
    return panel.getBoundingClientRect().width + (separator?.getBoundingClientRect().width ?? 0);
  }
  function reveal(panel: HTMLElement) {
    const { restingMargin, state } = stopSlide(panel);
    // The panel is now laid out where it will end, so fit terminals to that.
    previewLayout(() => () => {});
    slide.current = slidePanel(
      panel,
      anchor,
      restingMargin,
      state ?? { offset: slideDistance(panel), opacity: 0 },
      { offset: 0, opacity: 1 },
    );
  }
  useLayoutEffect(() => {
    if (open === shown.current) return;
    shown.current = open;
    const panel = element();
    if (instant || motionReduced()) {
      if (panel) stopSlide(panel);
      revealPending.current = false;
      setHidden(!open);
      return;
    }
    if (open) {
      // A hidden panel (possibly unmounted) is revealed once React has shown
      // it and its separator.
      if (hidden || !panel) {
        revealPending.current = true;
        setHidden(false);
      } else {
        reveal(panel);
      }
      return;
    }
    if (!panel) {
      setHidden(true);
      return;
    }
    revealPending.current = false;
    const separator = panelSeparator(panel, anchor);
    const { restingMargin, state } = stopSlide(panel);
    const distance = slideDistance(panel);
    previewLayout(() => {
      const panelDisplay = panel.style.display;
      const separatorDisplay = separator?.style.display ?? '';
      panel.style.display = 'none';
      if (separator) separator.style.display = 'none';
      return () => {
        panel.style.display = panelDisplay;
        if (separator) separator.style.display = separatorDisplay;
      };
    });
    slide.current = slidePanel(
      panel,
      anchor,
      restingMargin,
      state ?? { offset: 0, opacity: 1 },
      { offset: distance, opacity: 0 },
      () => {
        slide.current = null;
        panel.style.display = 'none';
        if (separator) separator.style.display = 'none';
        setHidden(true);
      },
    );
  }, [open]);
  useLayoutEffect(() => {
    if (hidden || !revealPending.current) return;
    revealPending.current = false;
    const panel = element();
    if (panel) reveal(panel);
  }, [hidden]);
  useEffect(() => () => slide.current?.animation.cancel(), []);
  return hidden;
}

/**
 * Eases a shown panel between widths when `width` changes, for example when a wider pane joins
 * the dock. A width set by dragging is already on screen when it is committed, so it does not
 * animate; nor does a hidden panel.
 */
export function useWidthMotion(element: RefObject<HTMLElement | null>, width: number) {
  const previous = useRef(width);
  // Read before React applies the new width, so a change mid-motion starts from where it is.
  const before = useRef<number | null>(null);
  if (width !== previous.current && before.current === null)
    before.current = element.current?.getBoundingClientRect().width ?? 0;
  const running = useRef<{ animation: Animation; release: () => void } | null>(null);
  function stop() {
    const current = running.current;
    running.current = null;
    current?.animation.cancel();
    current?.release();
  }
  useLayoutEffect(() => {
    if (width === previous.current) return;
    previous.current = width;
    const start = before.current;
    before.current = null;
    stop();
    const panel = element.current;
    if (!panel || !start || Math.abs(start - width) < 1 || motionReduced()) return;
    const animation = panel.animate(
      { width: [`${start}px`, `${width}px`], flexBasis: [`${start}px`, `${width}px`] },
      { duration: panelMs, easing: easeOutCss },
    );
    const current = { animation, release: holdPanelLayout() };
    running.current = current;
    animation.finished.then(
      () => {
        if (running.current !== current) return;
        running.current = null;
        current.release();
      },
      () => {},
    );
  }, [width]);
  useEffect(() => stop, []);
}

// Heights of a stack's panes; a hidden pane (or a hidden stack) measures 0.
function measureStack(container: HTMLElement | null) {
  const sizes = new Map<HTMLElement, number>();
  if (!container) return sizes;
  for (const child of container.children)
    if (child instanceof HTMLElement && child.hasAttribute('data-stack-item'))
      sizes.set(child, child.getBoundingClientRect().height);
  return sizes;
}

/**
 * Animates panes stacked in a flex column as they open and close. The panes are the
 * container's children marked `data-stack-item`, shown or hidden with display: none. One that
 * opens grows from nothing and one that closes shrinks away while the others give up or take
 * the room, so nothing in the column jumps. A closing pane stays shown (`data-stack-leaving`)
 * until it has shrunk away. `arrangement` names which panes are open; the motion runs when it
 * changes, but not as the whole column appears or leaves, which slides in or out as one.
 */
export function useStackMotion(container: RefObject<HTMLElement | null>, arrangement: string) {
  const previous = useRef(arrangement);
  // Read before React applies the new arrangement, so mid-motion sizes are where panes are now.
  const before = useRef<Map<HTMLElement, number> | null>(null);
  if (arrangement !== previous.current && !before.current) before.current = measureStack(container.current);
  const running = useRef<{ animations: Animation[]; leaving: HTMLElement[]; release: () => void } | null>(null);
  function stop() {
    const current = running.current;
    running.current = null;
    if (!current) return;
    current.animations.forEach((animation) => animation.cancel());
    current.leaving.forEach((pane) => pane.removeAttribute('data-stack-leaving'));
    current.release();
  }
  useLayoutEffect(() => {
    if (arrangement === previous.current) return;
    previous.current = arrangement;
    const from = before.current;
    before.current = null;
    stop();
    if (!from || motionReduced()) return;
    const to = measureStack(container.current);
    const total = (sizes: Map<HTMLElement, number>) => [...sizes.values()].reduce((sum, size) => sum + size, 0);
    if (!total(from) || !total(to)) return;
    const animations: Animation[] = [];
    const leaving: HTMLElement[] = [];
    for (const [pane, end] of to) {
      const start = from.get(pane) ?? 0;
      if (!start && !end) continue;
      if (!end) {
        pane.setAttribute('data-stack-leaving', '');
        leaving.push(pane);
      }
      animations.push(
        pane.animate(
          {
            flexGrow: [0, 0],
            flexShrink: [0, 0],
            flexBasis: [`${start}px`, `${end}px`],
            minHeight: ['0px', '0px'],
            ...(!start ? { opacity: [0, 1] } : !end ? { opacity: [1, 0] } : null),
          },
          { duration: panelMs, easing: easeOutCss },
        ),
      );
    }
    if (!animations.length) return;
    const current = { animations, leaving, release: holdPanelLayout() };
    running.current = current;
    Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (running.current !== current) return;
        running.current = null;
        leaving.forEach((pane) => pane.removeAttribute('data-stack-leaving'));
        current.release();
      },
      () => {},
    );
  }, [arrangement]);
  useEffect(() => stop, []);
}

const pressable = 'button, [role="button"]';
/* Cards whose clickable area is an inner button should move as one piece. */
const pressCard = '.agent-picker-option, .agent-option';
/* Compact controls and rows stay still so their icons and text do not jump. */
const stillControls = [
  '[role="menuitem"]',
  '[role="combobox"]',
  '.icon-button',
  '.text-button',
  '.tree-row',
  '.project-row',
  '.workspace-row',
  '.terminal-link',
  '.file-tab button',
  '.command-list button',
  '.sidebar-nav button',
  '.preferences-sidebar nav button',
  '.notification-item',
  '.search-result',
  '.change-row',
  '.git-entry',
  '.new-pane-trigger',
  '.workspace-views-trigger',
].join(', ');
const maxPressWidth = 260;
const compactWidth = 64;
const compactHeight = 32;

function pressScale(width: number) {
  return Math.max(0.96, Math.min(0.985, 1 - 3 / width));
}

/** Spring larger controls on press, without moving compact buttons or rows. */
export function usePressSprings() {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (motionReduced()) return;
      const control = event.target.closest<HTMLElement>(pressable);
      if (!control || control.matches(`:disabled, [aria-disabled="true"], ${stillControls}`)) return;
      if (control.closest('.xterm, .monaco-editor')) return;
      const controlRect = control.getBoundingClientRect();
      if (controlRect.width <= compactWidth || controlRect.height <= compactHeight) return;
      const element = control.closest<HTMLElement>(pressCard) || control;
      const width = element.getBoundingClientRect().width;
      if (!width || width > maxPressWidth) return;
      animate(element, { scale: pressScale(width) }, springs.press);
      const release = () => {
        animate(element, { scale: 1 }, springs.release);
        window.removeEventListener('pointerup', release, true);
        window.removeEventListener('pointercancel', release, true);
        window.removeEventListener('dragstart', release, true);
      };
      window.addEventListener('pointerup', release, true);
      window.addEventListener('pointercancel', release, true);
      window.addEventListener('dragstart', release, true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);
}
