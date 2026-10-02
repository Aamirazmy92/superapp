import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { layoutRect } from './AnchoredPopover';
import { FreezeOnExit, surfaceMotion } from './motion';

export type ChatSelectOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  tone?: 'danger';
};

type Placement = { top: number; left: number; minWidth: number; maxHeight: number; origin: string };
const margin = 8;
const gap = 6;

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
  emptyText = 'Nothing to choose from yet.',
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
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    // Closed: keep the last placement so the list fades out where it was.
    if (!open) return;
    setHighlight(Math.max(0, options.findIndex((option) => option.value === value)));
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
        top: downward ? a.bottom + gap : a.top - gap - shown,
        left: Math.min(Math.max(a.left, margin), innerWidth - margin - width),
        minWidth: Math.max(a.width, 168),
        maxHeight,
        origin: downward ? 'top left' : 'bottom left',
      });
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
    const last = options.length - 1;
    if (event.key === 'ArrowDown') setHighlight((i) => (i >= last ? 0 : i + 1));
    else if (event.key === 'ArrowUp') setHighlight((i) => (i <= 0 ? last : i - 1));
    else if (event.key === 'Home') setHighlight(0);
    else if (event.key === 'End') setHighlight(last);
    else if (event.key === 'Enter' || event.key === ' ') {
      if (options[highlight]) choose(options[highlight]);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close(false);
      return;
    } else {
      const key = event.key.toLowerCase();
      const starts = (option: ChatSelectOption) => option.label.toLowerCase().startsWith(key);
      const next = options.findIndex((option, index) => index > highlight && starts(option));
      const match = next >= 0 ? next : options.findIndex(starts);
      if (event.key.length === 1 && match >= 0) setHighlight(match);
      else return;
    }
    event.preventDefault();
  }

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
        aria-activedescendant={open && options[highlight] ? `${id}-${highlight}` : undefined}
        title={title}
        disabled={disabled}
        className={`chat-select ${open ? 'open' : ''} ${selected?.tone === 'danger' ? 'danger' : ''} ${className}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onKey}
        onBlur={() => setOpen(false)}
      >
        {selected?.icon ?? icon}
        <span className="chat-select-value">{selected?.label || value || placeholder}</span>
        <ChevronDown size={12} className="chat-select-chevron" aria-hidden="true" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              {...surfaceMotion()}
              key="menu"
              ref={list}
              id={id}
              role="listbox"
              aria-label={label}
              className="chat-select-menu"
              style={{
                top: placement?.top ?? 0,
                left: placement?.left ?? 0,
                minWidth: placement?.minWidth ?? 168,
                maxHeight: placement?.maxHeight,
                transformOrigin: placement?.origin,
                visibility: placement ? 'visible' : 'hidden',
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <FreezeOnExit>
                {heading && <div className="chat-select-heading">{heading}</div>}
                {options.map((option, index) => (
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
                    {option.icon && <span className="chat-select-icon">{option.icon}</span>}
                    <span className="chat-select-text">
                      <span>{option.label}</span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {option.value === value && (
                      <Check size={13} className="chat-select-check" aria-hidden="true" />
                    )}
                  </div>
                ))}
                {!options.length && <div className="chat-select-empty">{emptyText}</div>}
              </FreezeOnExit>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
