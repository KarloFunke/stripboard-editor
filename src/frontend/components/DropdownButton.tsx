"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** The chevron that marks a button as opening a menu, drawn so its ink centres on the label */
export function ChevronDownIcon() {
  return (
    <svg
      width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
      className="opacity-70" aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * A button that opens a menu below it. The trigger's look, the menu surface
 * and its contents belong to the caller; this owns the open state and closing
 * when the user clicks outside.
 */
export default function DropdownButton({
  label,
  title,
  align = "right",
  disabled,
  className = "",
  buttonClassName,
  menuClassName,
  children,
}: {
  /** Trigger contents, shown before the chevron */
  label: ReactNode;
  title?: string;
  align?: "left" | "right";
  disabled?: boolean;
  /** Classes of the wrapper around trigger and menu */
  className?: string;
  /** Trigger classes, as a function when the open state changes their look */
  buttonClassName: string | ((open: boolean) => string);
  menuClassName: string;
  /** Menu contents; call close to dismiss the menu after an action */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        aria-expanded={open}
        className={typeof buttonClassName === "function" ? buttonClassName(open) : buttonClassName}
      >
        {label}
        <ChevronDownIcon />
      </button>
      {open && (
        <div className={`absolute top-full mt-1 ${align === "left" ? "left-0" : "right-0"} ${menuClassName}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
