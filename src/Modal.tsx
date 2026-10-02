import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { motion, useIsPresent } from 'motion/react';
import { Backdrop, MotionDialog } from './motion';

export default function Modal({
  title,
  children,
  onClose,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const present = useIsPresent();
  useEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
    const first =
      host.current?.querySelector<HTMLElement>('input, textarea, select') ||
      host.current?.querySelector<HTMLElement>('button');
    first?.focus();
    return () => previous.current?.focus();
  }, []);
  // The dialog stays mounted while it fades out; return focus as soon as it starts closing.
  useEffect(() => {
    if (!present) previous.current?.focus();
  }, [present]);
  return (
    <Backdrop
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <MotionDialog
        dialogRef={host}
        className={`settings-modal tool-modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-title">
          <h2>{title}</h2>
          <button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </MotionDialog>
    </Backdrop>
  );
}
