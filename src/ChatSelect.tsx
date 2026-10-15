import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight } from './icons';
import { AnimatePresence } from 'motion/react';
import { layoutRect } from './AnchoredPopover';
import { fadeMotion, FreezeOnExit, motionReduced, PopoverSurface, PresenceDiv } from './motion';

export type ChatSelectOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  tone?: 'danger';
  /** Small pill after the label (model layout only). */
  badge?: string;
  /** Listed after the numbered rows, without a number; `trailing` is shown at its right edge. */
  footer?: boolean;
  trailing?: string;
};

type Placement = { top: number; left: number; minWidth: number; maxHeight: number; origin: string };
const margin = 8;
const gap = 6;

/* Matches the reference recording: ~110ms ease-out in, ~80ms out, sliding 4px out of the trigger. */
function dropdownMotion(downward: boolean) {
  if (motionReduced()) return fadeMotion();
  const y = downward ? -4 : 4;
  return {
    initial: { opacity: 0, y },
    animate: {
      opacity: 1,
      y: 0,
      pointerEvents: 'auto' as const,
      transition: { duration: 0.11, ease: [0.16, 1, 0.3, 1] as const },
    },
    exit: {
      opacity: 0,
      y: y / 2,
      pointerEvents: 'none' as const,
      transition: { duration: 0.08, ease: [0.4, 0, 0.2, 1] as const },
    },
  };
}

export default function ChatSelect({
  label,
  heading,
  value,
  options,
  onChange,
  icon,
  placeholder = 'Select',
  disabled,
  title,
  className = '',
  variant = 'chip',
  emptyText = 'Nothing to choose from yet.',
  featured,
  moreLabel = 'More',
  compact: compactProp,
}: {
  label: string;
  heading?: string;
  value: string;
  options: ChatSelectOption[];
  onChange(value: string): void;
  icon?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  /** 'field' is a bordered form control; 'chip' is the quiet inline trigger used in chat. */
  variant?: 'chip' | 'field';
  emptyText?: string;
  /**
   * Compact picker: only the first `featured` options are listed (the current one shows a
   * check); the rest sit behind a flyout row labelled `moreLabel`.
   */
  featured?: number;
  moreLabel?: string;
  /** The flat Claude menu layout. Implied by `featured`. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.find((option) => option.value === value);
  const compact = compactProp ?? featured !== undefined;
  const main = options.filter((option) => !option.footer);
  const foot = options.filter((option) => option.footer);
  const split = featured !== undefined && main.length > featured + 1 ? featured : main.length;
  const top = main.slice(0, split);
  const more = main.slice(split);
  const footBase = top.length + (more.length ? 1 : 0);
  const rows = footBase + foot.length;
  const rowOption = (index: number) => (index < top.length ? top[index] : foot[index - footBase]);
  const [subHighlight, setSubHighlight] = useState(-1);
  const [subFocus, setSubFocus] = useState(false);
  const subOpen = more.length > 0 && highlight === top.length;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    // Closed: keep the last placement so the list fades out where it was.
    if (!open) return;
    const inMain = main.findIndex((option) => option.value === value);
    const inFoot = foot.findIndex((option) => option.value === value);
    setHighlight(inMain >= 0 ? Math.min(inMain, top.length) : inFoot >= 0 ? footBase + inFoot : 0);
    setSubHighlight(-1);
    setSubFocus(false);
    const place = () => {
      const anchor = trigger.current;
      const menu = list.current;
      if (!anchor || !menu) return;
      const a = layoutRect(anchor);
      const below = innerHeight - a.bottom - gap - margin;
      const above = a.top - gap - margin;
      const height = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
      const downward = height <= below || below >= above;
      const maxHeight = Math.max(120, Math.min(320, downward ? below : above));
      const shown = Math.min(height, maxHeight);
      const width = menu.offsetWidth;
      setPlacement({
        // Whole pixels: a fractional position makes text re-snap when the animation ends.
        top: Math.round(downward ? a.bottom + gap : a.top - gap - shown),
        left: Math.round(Math.min(Math.max(a.left, margin), innerWidth - margin - width)),
        minWidth: Math.round(Math.max(a.width, 168)),
        maxHeight,
        origin: downward ? 'top left' : 'bottom left',
      });
      return downward;
    };
    place();
    const observer = new ResizeObserver(place);
    if (list.current) observer.observe(list.current);
    window.addEventListener('resize', place);
    const onScroll = (event: Event) => {
      if (!list.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('scroll', onScroll, true);
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !trigger.current?.contains(target) &&
        !list.current?.contains(target)
      )
        setOpen(false);
    };
    const onBlur = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('blur', onBlur);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);
  useEffect(() => {
    const menu = list.current;
    const item = menu?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    if (!open || !menu || !item) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop - 4;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight + 4;
  }, [open, highlight, placement]);

  function close(refocus = true) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }
  function choose(option: ChatSelectOption) {
    if (option.value !== value) onChange(option.value);
    close();
  }
  function onKey(event: React.KeyboardEvent) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    const last = rows - 1;
    if (subOpen && subFocus) {
      if (event.key === 'ArrowDown') setSubHighlight((i) => (i >= more.length - 1 ? 0 : i + 1));
      else if (event.key === 'ArrowUp') setSubHighlight((i) => (i <= 0 ? more.length - 1 : i - 1));
      else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
        setSubFocus(false);
        setSubHighlight(-1);
        event.stopPropagation();
      } else if (event.key === 'Enter' || event.key === ' ') {
        if (more[subHighlight]) choose(more[subHighlight]);
      } else if (event.key === 'Tab') {
        close(false);
        return;
      } else return;
      event.preventDefault();
      return;
    }
    if (subOpen && (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ')) {
      setSubFocus(true);
      setSubHighlight(Math.max(0, more.findIndex((option) => option.value === value)));
    } else if (event.key === 'ArrowDown') setHighlight((i) => (i >= last ? 0 : i + 1));
    else if (event.key === 'ArrowUp') setHighlight((i) => (i <= 0 ? last : i - 1));
    else if (event.key === 'Home') setHighlight(0);
    else if (event.key === 'End') setHighlight(last);
    else if (event.key === 'Enter' || event.key === ' ') {
      const option = rowOption(highlight);
      if (option) choose(option);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close(false);
      return;
    } else {
      const key = event.key.toLowerCase();
      const starts = (option: ChatSelectOption) => option.label.toLowerCase().startsWith(key);
      const next = top.findIndex((option, index) => index > highlight && starts(option));
      const match = next >= 0 ? next : top.findIndex(starts);
      if (event.key.length === 1 && match >= 0) setHighlight(match);
      else return;
    }
    event.preventDefault();
  }

  const flip = placement
    ? placement.left + (list.current?.offsetWidth ?? 240) + 3 + 236 > innerWidth - margin
    : false;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && highlight < rows ? `${id}-${highlight}` : undefined}
        title={title}
        disabled={disabled}
        className={`chat-select ${variant === 'field' ? 'chat-select-field' : ''} ${open ? 'open' : ''} ${selected?.tone === 'danger' ? 'danger' : ''} ${className}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onKey}
        onBlur={() => setOpen(false)}
      >
        {selected?.icon ?? icon}
        <span className="chat-select-value">{selected?.label || value || placeholder}</span>
        <ChevronDown size={14} className="chat-select-chevron" aria-hidden="true" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <PresenceDiv
              {...dropdownMotion(placement?.origin.startsWith('top') ?? true)}
              key="menu"
              className={`chat-select-menu ${compact ? 'compact' : ''}`}
              style={{
                top: placement?.top ?? 0,
                left: placement?.left ?? 0,
                minWidth: placement?.minWidth ?? 168,
                transformOrigin: placement?.origin,
                visibility: placement ? 'visible' : 'hidden',
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {/* The panel scales behind the list; the text only fades, so it never re-rasterises. */}
              <PopoverSurface origin={placement?.origin} />
              <div
                ref={list}
                id={id}
                role="listbox"
                aria-label={label}
                className="chat-select-list"
                style={{ maxHeight: placement?.maxHeight }}
              >
              <FreezeOnExit>
                {heading && featured === undefined && <div className="chat-select-heading">{heading}</div>}
                {top.map((option, index) => (
                  <div
                    key={option.value || '__empty'}
                    id={`${id}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={option.value === value}
                    className={`chat-select-option ${index === highlight ? 'highlight' : ''} ${option.tone === 'danger' ? 'danger' : ''}`}
                    onPointerMove={() => setHighlight(index)}
                    onClick={() => choose(option)}
                  >
                    {!compact && (
                      <span className="chat-select-gutter" aria-hidden="true">
                        {option.value === value && <Check size={14} className="chat-select-check" />}
                      </span>
                    )}
                    {option.icon && <span className="chat-select-icon">{option.icon}</span>}
                    <span className="chat-select-text">
                      <span className="chat-select-title">
                        {option.label}
                        {option.badge && <span className="chat-select-badge">{option.badge}</span>}
                      </span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {compact && option.value === value && (
                      <Check size={14} className="chat-select-check" aria-hidden="true" />
                    )}
                  </div>
                ))}
                {more.length > 0 && (
                  <>
                    <div className="chat-select-separator" role="separator" />
                    <div
                      id={`${id}-${top.length}`}
                      data-index={top.length}
                      role="option"
                      aria-selected={false}
                      aria-haspopup="menu"
                      aria-expanded={subOpen}
                      className={`chat-select-option chat-select-more ${subOpen ? 'highlight' : ''}`}
                      onPointerMove={() => setHighlight(top.length)}
                    >
                      <span className="chat-select-text">
                        <span>{moreLabel}</span>
                      </span>
                      <ChevronRight size={14} className="chat-select-key" aria-hidden="true" />
                    </div>
                  </>
                )}
                {foot.map((option, j) => {
                  const index = footBase + j;
                  return (
                    <div
                      key={option.value}
                      id={`${id}-${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={option.value === value}
                      className={`chat-select-option chat-select-footer ${index === highlight ? 'highlight' : ''}`}
                      onPointerMove={() => setHighlight(index)}
                      onClick={() => choose(option)}
                    >
                      <span className="chat-select-text">
                        <span>{option.label}</span>
                        {option.description && <small>{option.description}</small>}
                      </span>
                      {option.value === value ? (
                        <Check size={14} className="chat-select-check" aria-hidden="true" />
                      ) : (
                        option.trailing && <span className="chat-select-trailing">{option.trailing}</span>
                      )}
                    </div>
                  );
                })}
                {!options.length && <div className="chat-select-empty">{emptyText}</div>}
              </FreezeOnExit>
              </div>
              {subOpen && (
                <div
                  role="listbox"
                  aria-label={moreLabel}
                  className={`chat-select-sub ${placement?.origin.startsWith('top') ? 'down' : 'up'} ${flip ? 'flip' : ''}`}
                >
                  {more.map((option, index) => (
                    <div
                      key={option.value}
                      role="option"
                      aria-selected={option.value === value}
                      className={`chat-select-option ${index === subHighlight ? 'highlight' : ''}`}
                      onPointerMove={() => setSubHighlight(index)}
                      onClick={() => choose(option)}
                    >
                      <span className="chat-select-text">
                        <span className="chat-select-title">
                          {option.label}
                          {option.badge && <span className="chat-select-badge">{option.badge}</span>}
                        </span>
                      </span>
                      {option.value === value && (
                        <Check size={14} className="chat-select-check" aria-hidden="true" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </PresenceDiv>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
