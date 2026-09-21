"use client";

import { useEffect, useState } from "react";

const SHORTCUTS = [
  { section: "General", items: [
    ["Ctrl + Z", "Undo"],
    ["Ctrl + Y / Ctrl + Shift + Z", "Redo"],
    ["?", "Toggle this overlay"],
  ]},
  { section: "Schematic", items: [
    ["Click / drag a box", "Select; left to right encloses, right to left touches"],
    ["Ctrl / Shift + click", "Add or toggle items in the selection"],
    ["Ctrl + A", "Select every component, wire and flag"],
    ["Drag from a pin", "Draw a wire, in any mode"],
    ["W", "Toggle wire drawing mode"],
    ["Enter", "Finish the wire being drawn"],
    ["Backspace", "Take back the last segment while drawing"],
    ["G / P / L", "Drop a ground, power or net label at the cursor"],
    ["Double-click a flag", "Rename it"],
    ["R / M", "Rotate / mirror the selection"],
    ["E", "Exclude / include selected component(s) on the stripboard"],
    ["Ctrl + C / V / D", "Copy, paste, duplicate the selection"],
    ["Delete", "Remove the selection"],
    ["Alt + Delete", "Remove the whole wire, not just the segment"],
    ["Escape", "Cancel wire / clear selection / exit wire mode"],
    ["Arrow keys / Drag", "Move the selection, one or many (Shift: five steps)"],
    ["Right-click drag", "Pan canvas"],
    ["Scroll wheel", "Zoom"],
  ]},
  { section: "Stripboard", items: [
    ["R", "Rotate selected component"],
    ["L", "Lock / unlock selected component(s) so auto-layout keeps them in place"],
    ["Delete", "Remove selected component"],
    ["W", "Wire tool: click two holes to join them with a link wire"],
    ["C", "Cut tool: click a hole or between two to cut the strip, click a cut to remove it"],
    ["Escape", "Cancel wire / clear selection / put the tool down"],
    ["Arrow keys / Drag", "Move selected components and wires, one or many"],
    ["Right-click", "Insert or delete the board row / column under the pointer"],
    ["Right-click drag", "Pan canvas"],
    ["Scroll wheel", "Zoom"],
  ]},
];

export default function ShortcutOverlay() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const toggle = () => setShow((s) => !s);
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "?" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        toggle();
      }
    };
    // Also openable from UI (e.g. the "?" button in the project toolbar)
    window.addEventListener("keydown", keyHandler);
    window.addEventListener("toggle-shortcuts", toggle);
    return () => {
      window.removeEventListener("keydown", keyHandler);
      window.removeEventListener("toggle-shortcuts", toggle);
    };
  }, []);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={() => setShow(false)}
    >
      <div
        className="font-mono bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900/50 p-6 max-w-lg w-[calc(100%-2rem)] max-h-[80vh] overflow-y-auto"
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
            <h3 className="font-mono text-xs font-semibold text-[var(--copper)] uppercase tracking-[0.15em] mb-2">
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
