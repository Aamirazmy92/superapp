import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence } from 'motion/react';
import { AnchoredPopover } from './AnchoredPopover';

/**
 * Reasoning effort as a stepped slider. `levels` run from fastest to smartest;
 * an empty string means "use the model's own default".
 */
export default function ChatEffort({
  levels,
  value,
  defaultLevel,
  label,
  disabled,
  title,
  name,
  onChange,
}: {
  levels: string[];
  value: string;
  defaultLevel: string;
  label: string;
  disabled?: boolean;
  title?: string;
  name(level: string): string;
  onChange(level: string): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const last = Math.max(0, levels.length - 1);
  const index = Math.max(0, levels.indexOf(value));
  const isDefault = value === defaultLevel;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (trigger.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.chat-effort-pop')) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    requestAnimationFrame(() => document.getElementById(id)?.focus());
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
  }, [open, id]);

  const fill = last ? (index / last) * 100 : 100;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        className={`chat-select chat-effort-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-select-value">{name(value)}</span>
      </button>
      <AnimatePresence>
        {open && (
          <AnchoredPopover anchor={trigger.current} className="chat-effort-pop" role="dialog" label={label}>
            <div ref={panel} className="chat-effort-body">
              <div className="chat-effort-head">
                <span>Effort</span>
                <strong>{name(value)}</strong>
              </div>
              <div
                className="chat-effort-slider"
                style={{ '--steps': last, '--fill': `${fill}%` } as CSSProperties}
              >
                <div className="chat-effort-track" aria-hidden="true">
                  <span className="chat-effort-fill" />
                  {levels.map((level, i) => (
                    <i key={level || '__default'} className={i <= index ? 'passed' : ''} style={{ left: `${last ? (i / last) * 100 : 0}%` }} />
                  ))}
                </div>
                <input
                  id={id}
                  type="range"
                  min={0}
                  max={last}
                  step={1}
                  value={index}
                  aria-label={label}
                  aria-valuetext={name(value)}
                  onChange={(event) => onChange(levels[Number(event.target.value)])}
                />
              </div>
              <div className="chat-effort-ends">
                <span>Faster</span>
                <span>Smarter</span>
              </div>
              <p className="chat-effort-note">{isDefault ? 'Recommended' : `Recommended: ${name(defaultLevel)}`}</p>
            </div>
          </AnchoredPopover>
        )}
      </AnimatePresence>
    </>
  );
}
