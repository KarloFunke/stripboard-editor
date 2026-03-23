"use client";

import { useEffect, useState } from "react";

const SHORTCUTS = [
  { section: "General", items: [
    ["Ctrl + Z", "Undo"],
    ["Ctrl + Y", "Redo"],
    ["Ctrl + S", "Save"],
    ["?", "Toggle this overlay"],
  ]},
  { section: "Schematic", items: [
    ["W", "Toggle wire drawing mode"],
    ["R", "Rotate selected component"],
    ["M", "Mirror selected component"],
    ["Delete", "Remove selected component or wire"],
    ["Escape", "Cancel wire / clear selection / exit wire mode"],
    ["Arrow keys", "Move selected components"],
    ["Right-click drag", "Pan canvas"],
    ["Scroll wheel", "Zoom"],
  ]},
  { section: "Stripboard", items: [
    ["R", "Rotate selected component"],
    ["Delete", "Remove selected component"],
    ["Escape", "Clear selection"],
    ["Arrow keys", "Move selected components"],
    ["Right-click drag", "Pan canvas"],
    ["Scroll wheel", "Zoom"],
  ]},
];

export default function ShortcutOverlay() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "?" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setShow((s) => !s);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={() => setShow(false)}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 max-w-lg w-[calc(100%-2rem)] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Keyboard Shortcuts</h2>
          <button
            onClick={() => setShow(false)}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-400 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {SHORTCUTS.map((group) => (
          <div key={group.section} className="mb-4 last:mb-0">
            <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">
              {group.section}
            </h3>
            <div className="space-y-1">
              {group.items.map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between py-0.5">
                  <span className="text-sm text-neutral-600 dark:text-neutral-400">{desc}</span>
                  <kbd className="px-1.5 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600 rounded text-xs font-mono text-neutral-700 dark:text-neutral-300 ml-4 whitespace-nowrap">
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}

        <p className="text-xs text-neutral-400 dark:text-neutral-500 mt-4 text-center">
          Press <kbd className="px-1 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded text-xs font-mono">?</kbd> to close
        </p>
      </div>
    </div>
  );
}
