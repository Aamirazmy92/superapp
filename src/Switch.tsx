import type { ButtonHTMLAttributes } from 'react';
import { motion } from 'motion/react';

type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name. Leave out when the switch sits inside a <label> that already names it. */
  label?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'aria-checked' | 'aria-label'>;

/** The app's only on/off toggle. Styling lives in switch.css; colours come from the --switch-* tokens. */
export function Switch({ checked, onChange, disabled, label, className, ...rest }: SwitchProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={className ? `switch ${className}` : 'switch'}
      onClick={() => onChange(!checked)}
    >
      <motion.span
        className="switch-thumb"
        aria-hidden="true"
        initial={false}
        animate={{ x: checked ? 16 : 0, width: 20 }}
        whileTap={disabled ? undefined : { x: checked ? 14 : 0, width: 22 }}
        transition={{ type: 'spring', stiffness: 1000, damping: 42, mass: 0.7 }}
      />
    </button>
  );
}
