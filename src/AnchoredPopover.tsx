import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { fadeMotion, FreezeOnExit, PopoverSurface, surfaceMotion, useClosingProps } from './motion';

type Placement = { top: number; left: number; origin: string };

const margin = 8;

/**
 * The anchor's box without CSS transforms. Buttons briefly scale on press, so
 * getBoundingClientRect alone would place a menu against the shrunken trigger.
 */
export function layoutRect(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const width = element.offsetWidth || rect.width;
  const height = element.offsetHeight || rect.height;
  const left = rect.left + rect.width / 2 - width / 2;
  const top = rect.top + rect.height / 2 - height / 2;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * Floats a menu in `document.body`, positioned against its trigger so no scroll
 * container can clip it. It opens below the trigger, flips above when the
 * viewport is too short, and is clamped inside the window edges.
 * `align="window"` pins the right edge to the window instead of the trigger.
 */
export function AnchoredPopover({
  anchor,
  align = 'end',
  gap = 6,
  className,
  role,
  label,
  animateSurface = true,
  contentAnimation = 'surface',
  children,
}: {
  anchor: HTMLElement | null;
  align?: 'start' | 'end' | 'window';
  gap?: number;
  className: string;
  role?: string;
  label?: string;
  animateSurface?: boolean;
  contentAnimation?: 'fade' | 'surface';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !anchor) return;
    const place = () => {
      const a = layoutRect(anchor);
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const fitsBelow = a.bottom + gap + height <= innerHeight - margin;
      const fitsAbove = a.top - gap - height >= margin;
      const below = fitsBelow || !fitsAbove;
      const top = below
        ? Math.min(a.bottom + gap, innerHeight - margin - height)
        : a.top - gap - height;
      const preferred =
        align === 'start' ? a.left : align === 'end' ? a.right - width : innerWidth - margin - width;
      const left = Math.min(Math.max(preferred, margin), innerWidth - margin - width);
      /* Whole pixels: a fractional origin makes text re-snap when the open
         animation's transform ends, which reads as the text jumping. */
      setPlacement({
        top: Math.round(Math.max(margin, top)),
        left: Math.round(left),
        origin: `${below ? 'top' : 'bottom'} ${align === 'start' ? 'left' : 'right'}`,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [anchor, align, gap]);

  const motionProps = contentAnimation === 'surface' ? surfaceMotion() : fadeMotion();
  const closingProps = useClosingProps();

  return createPortal(
    <motion.div
      {...motionProps}
      {...closingProps}
      ref={ref}
      className={`${className} anchored-popover`}
      role={role}
      aria-label={label}
      style={{
        position: 'fixed',
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        transformOrigin: placement?.origin,
        visibility: placement ? 'visible' : 'hidden',
      }}
    >
      <PopoverSurface origin={placement?.origin} animateSurface={animateSurface} />
      <FreezeOnExit>{children}</FreezeOnExit>
    </motion.div>,
    document.body,
  );
}
