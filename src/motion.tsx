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
/* Crisp and immediate: surfaces are solid within ~100ms, never overshoot, and
   close with a plain fade. Same curve as --ease in design.css. */
const easeOut = [0.16, 1, 0.3, 1] as const;
const easeIn = [0.4, 0, 1, 1] as const;

export const springs = {
  press: { duration: 0.08, ease: easeOut },
  release: { duration: 0.14, ease: easeOut },
} satisfies Record<string, Transition>;

export const fade = {
  in: { duration: 0.1, ease: easeOut },
  out: { duration: 0.07, ease: easeIn },
} as const;

/*
 * Open: the panel grows from 97% out of the trigger while the content fades in
 * place, solid in ~90ms. Close: a short fade, with the panel easing back only
 * slightly. Content is never transformed, so text is rasterised once at its
 * final position and cannot shift or re-sharpen when the animation ends.
 */
const panelEnter = { duration: 0.16, ease: easeOut, opacity: { duration: 0.09, ease: easeOut } };
const panelLeave = { duration: 0.1, ease: easeIn };

const panelMotion = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: panelEnter },
  exit: { opacity: 0, scale: 0.985, transition: panelLeave },
} satisfies HTMLMotionProps<'span'>;

const contentMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.11, ease: easeOut } },
  exit: { opacity: 0, pointerEvents: 'none', transition: { duration: 0.08, ease: easeIn } },
} satisfies HTMLMotionProps<'div'>;

const instantMotion = {
  initial: false,
  animate: { opacity: 1, scale: 1, transition: { duration: 0 } },
  exit: { opacity: 1, scale: 1, transition: { duration: 0 } },
} satisfies HTMLMotionProps<'div'>;

/** For the element holding a floating surface's content: fades, never moves. */
export function surfaceMotion() {
  return motionReduced() ? instantMotion : contentMotion;
}

function panelMotionProps() {
  return motionReduced() ? instantMotion : panelMotion;
}

export function fadeMotion() {
  return motionReduced()
    ? {
        initial: false,
        animate: { opacity: 1, transition: { duration: 0 } },
        exit: { opacity: 1, pointerEvents: 'none' as const, transition: { duration: 0 } },
      }
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: fade.in },
        exit: { opacity: 0, pointerEvents: 'none' as const, transition: fade.out },
      };
}

const surfaceKinds = { popover: true, dialog: true, toast: true } as const;
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
  kind?: keyof typeof surfaceKinds;
  origin?: string;
  rect?: SurfaceRect;
  animateSurface?: boolean;
}) {
  return (
    <motion.span
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
      {...(animateSurface ? panelMotionProps() : {})}
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
  const Tag = as === 'section' ? motion.section : as === 'form' ? motion.form : motion.div;
  return (
    <>
      {rect && <Surface kind="dialog" rect={rect} />}
      <Tag
        {...(surfaceMotion() as object)}
        {...(props as object)}
        ref={setRef as never}
        className={`${className} has-motion-surface`}
      >
        <FreezeOnExit>{children}</FreezeOnExit>
      </Tag>
    </>
  );
}

export function Backdrop(props: HTMLMotionProps<'div'>) {
  return (
    <motion.div
      {...fadeMotion()}
      {...props}
    />
  );
}

/** Set from Settings → Appearance; also covers CSS via the `reduce-motion` class. */
export function motionReduced() {
  return document.documentElement.classList.contains('reduce-motion');
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

type SlideState = { offset: number; opacity: number };
type Slide = {
  animation: Animation;
  restingMargin: number;
  // Whether this slide added the terminal hold and so must release it.
  ownsHold: boolean;
  // Set when a new slide takes over, which then releases the hold instead.
  handedOff: boolean;
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
  previous: Slide | null,
  onFinish?: () => void,
): Slide {
  const body = document.body;
  const ownsHold = previous
    ? previous.ownsHold
    : !body.classList.contains('dashboard-layout-transitioning');
  if (previous) previous.handedOff = true;
  body.classList.add('dashboard-layout-transitioning');
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
    { duration: 220, easing: easeOutCss },
  );
  const slide: Slide = { animation, restingMargin, ownsHold, handedOff: false };
  let finished = false;
  const done = (completed: boolean) => {
    if (finished) return;
    finished = true;
    // Runs before the next frame, so a closed panel never flashes back in
    // between the animation ending and React hiding it.
    if (completed) onFinish?.();
    if (!slide.ownsHold || slide.handedOff) return;
    body.classList.remove('dashboard-layout-transitioning');
    window.dispatchEvent(new Event('dashboard-layout-settled'));
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
      return { restingMargin, state: null, running };
    }
    const style = getComputedStyle(panel);
    const state = {
      offset: running.restingMargin - (parseFloat(style[innerMargin(anchor)]) || 0),
      opacity: parseFloat(style.opacity),
    };
    running.animation.cancel();
    return { restingMargin: running.restingMargin, state, running };
  }
  function slideDistance(panel: HTMLElement) {
    const separator = panelSeparator(panel, anchor);
    return panel.getBoundingClientRect().width + (separator?.getBoundingClientRect().width ?? 0);
  }
  function reveal(panel: HTMLElement) {
    const { restingMargin, state, running } = stopSlide(panel);
    // The panel is now laid out where it will end, so fit terminals to that.
    previewLayout(() => () => {});
    slide.current = slidePanel(
      panel,
      anchor,
      restingMargin,
      state ?? { offset: slideDistance(panel), opacity: 0 },
      { offset: 0, opacity: 1 },
      running,
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
    const { restingMargin, state, running } = stopSlide(panel);
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
      running,
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
