"use client";

import { useEffect, useRef, useState } from "react";

export interface ViewToggle {
  key: string;
  label: string;
  title: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

/**
 * The board's display options, behind one button. They accumulate faster than
 * the toolbar has room for, and none of them is reached mid-gesture.
 */
export default function ViewMenu({ items }: { items: ViewToggle[] }) {
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

  const on = items.filter((i) => i.checked).length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="What the board shows"
        className={`px-2 py-1 rounded border transition-colors whitespace-nowrap flex items-center gap-1 ${open || on > 0
          ? "border-[#113768] text-[#113768] bg-[#113768]/10 dark:border-[#5b9bd5] dark:text-[#5b9bd5] dark:bg-[#5b9bd5]/15"
          : "border-neutral-300 dark:border-neutral-600 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
      >
        View
        <span className="text-[9px] leading-none opacity-60">▼</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-[12rem] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg dark:shadow-neutral-900/40 py-1 z-30">
          {items.map((item) => (
            <label
              key={item.key}
              title={item.title}
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              <input
                type="checkbox"
                checked={item.checked}
                onChange={(e) => item.onChange(e.target.checked)}
                className="cursor-pointer accent-[#113768] dark:accent-[#5b9bd5]"
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
