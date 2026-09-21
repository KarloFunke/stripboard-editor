"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface CanvasAction {
  /** Stable React key */
  key: string;
  /** Visible button label */
  label: string;
  /** Tooltip (include the keyboard shortcut hint where one exists) */
  title: string;
  icon: ReactNode;
  onClick: () => void;
  /** Keyboard shortcut label shown as a subtle keycap on the button (e.g. "R", "Del") */
  shortcut?: string;
  /** "danger" gives the button a red hover (used for destructive actions) */
  variant?: "default" | "danger";
  /** Turns the button into a dropdown; onClick is then ignored. */
  menu?: CanvasMenuItem[];
}

export interface CanvasMenuItem {
  key: string;
  label: string;
  /** Shows a tick, for a set of alternatives where one is current */
  checked?: boolean;
  /** Draws a rule above this item */
  separated?: boolean;
  title?: string;
  onClick: () => void;
}

function MenuButton({ action }: { action: CanvasAction }) {
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
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={action.title}
        className="flex items-center gap-1.5 whitespace-nowrap text-xs px-2.5 py-1.5 rounded text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
      >
        {action.icon}
        {action.label}
        <span className="text-[9px] leading-none opacity-60">▼</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 min-w-[13rem] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg dark:shadow-neutral-900/40 py-1 z-20">
          {action.menu!.map((item) => (
            <button
              key={item.key}
              title={item.title}
              onClick={() => { item.onClick(); setOpen(false); }}
              className={`w-full text-left text-xs px-3 py-1.5 flex items-center gap-2 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 ${
                item.separated ? "border-t border-neutral-200 dark:border-neutral-700 mt-1 pt-2" : ""
              }`}
            >
              <span className="w-3 text-[var(--accent)] dark:text-[var(--accent-light)]">{item.checked ? "✓" : ""}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Fixed action bar shown inside a canvas (schematic or stripboard) when a
 * component is selected. Pinned top-center of the canvas viewport, mirroring
 * the existing bottom-right zoom-control overlay pattern, so it never collides
 * with it. Each canvas owns its own selection state and passes the relevant
 * actions in — keeping selection state local to the canvas (no state lifting).
 */
export function SelectionActionBar({ actions }: { actions: CanvasAction[] }) {
  if (actions.length === 0) return null;
  // Centred in the room right of the tool strip, wrapping rather than running under it
  return (
    <div className="absolute top-3 left-[4.25rem] right-3 z-10 flex justify-center pointer-events-none">
    <div className="pointer-events-auto flex flex-wrap justify-center items-center gap-1 bg-white/95 dark:bg-neutral-800/95 border border-neutral-200 dark:border-neutral-700 rounded-md px-1.5 py-1 shadow-sm dark:shadow-neutral-900/30">
      {actions.map((a) => (a.menu ? (
        <MenuButton key={a.key} action={a} />
      ) : (
        <button
          key={a.key}
          onClick={a.onClick}
          title={a.title}
          className={`flex items-center gap-1.5 whitespace-nowrap text-xs px-2.5 py-1.5 rounded text-neutral-600 dark:text-neutral-400 ${
            a.variant === "danger"
              ? "hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/40 dark:hover:text-red-400"
              : "hover:bg-neutral-100 dark:hover:bg-neutral-700"
          }`}
        >
          {a.icon}
          {a.label}
          {a.shortcut && (
            <kbd className="ml-0.5 px-1 py-0.5 text-[10px] leading-none font-mono rounded border border-neutral-300/80 dark:border-neutral-600/80 text-neutral-400 dark:text-neutral-500">
              {a.shortcut}
            </kbd>
          )}
        </button>
      )))}
    </div>
    </div>
  );
}

// Shared icons so both canvases stay visually consistent.

export const RotateIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 3v5h-5" />
  </svg>
);

export const MirrorIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v18" strokeDasharray="3 3" />
    <path d="M8 7 4 12l4 5z" />
    <path d="M16 7l4 5-4 5z" />
  </svg>
);

export const DeleteIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

export const ExcludeIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6l12.8 12.8" />
  </svg>
);

export const LockIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export const UnlockIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.9-.9" />
  </svg>
);

export const WandIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 4V2" />
    <path d="M15 10V8" />
    <path d="M12.5 5.5h-2" />
    <path d="M19.5 5.5h-2" />
    <path d="M14 7 3 18l3 3L17 10z" />
  </svg>
);

export const FootprintIcon = (
  <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <rect x="1" y="1" width="10" height="10" rx="1" />
    <circle cx="3.5" cy="3.5" r="1" fill="currentColor" />
    <circle cx="8.5" cy="8.5" r="1" fill="currentColor" />
  </svg>
);

// A wire leaving the board: a part mounted off it and wired in.
export const OffBoardIcon = (
  <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="5" width="5" height="6" rx="1" />
    <path d="M6 8 C 9 8 8 2 11 2" />
    <circle cx="11" cy="2" r="0.6" fill="currentColor" />
  </svg>
);

export const PackageIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 8v8l-9 5-9-5V8l9-5z" />
    <path d="M3.3 7.5 12 12.5l8.7-5" />
    <path d="M12 12.5V21" />
  </svg>
);
