"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { spanLimits, DEFAULT_CLEARANCE } from "./flexGeometry";
import { defaultPermWorkers } from "./layoutTypes";

/**
 * Popup with per-component-type auto-layout settings: the allowed pin-to-pin
 * span range of the flexible parts used in this project. Rendered below the
 * gear button next to the Auto-layout button.
 */
export default function AutoLayoutSettings({ onClose }: { onClose: () => void }) {
  const components = useProjectStore((s) => s.components);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const spanOverrides = useProjectStore((s) => s.spanOverrides);
  const setSpanOverride = useProjectStore((s) => s.setSpanOverride);
  const clearanceOverrides = useProjectStore((s) => s.clearanceOverrides);
  const setClearanceOverride = useProjectStore((s) => s.setClearanceOverride);
  const drilledCutsOnly = useProjectStore((s) => s.drilledCutsOnly);
  const setDrilledCutsOnly = useProjectStore((s) => s.setDrilledCutsOnly);
  const permWorkers = useProjectStore((s) => s.permWorkers);
  const setPermWorkers = useProjectStore((s) => s.setPermWorkers);
  const v5TimeS = useProjectStore((s) => s.v5TimeS);
  const setV5TimeS = useProjectStore((s) => s.setV5TimeS);
  const noWireStacking = useProjectStore((s) => s.noWireStacking);
  const setNoWireStacking = useProjectStore((s) => s.setNoWireStacking);
  const v5RandomSeeds = useProjectStore((s) => s.v5RandomSeeds);
  const setV5RandomSeeds = useProjectStore((s) => s.setV5RandomSeeds);
  const cores = Math.max(1, typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4);
  const workers = Math.min(permWorkers ?? defaultPermWorkers(cores), cores);
  // Slider stops for the portfolio size; 1 = off (single solve)
  // v5 anneal budget stops; 0 = auto (size-scaled default)
  const V5_TIME_STOPS = [15, 30, 60, 120, 300];

  // The editor panes clip absolutely-positioned children (overflow-hidden),
  // so the panel is fixed to the viewport instead: anchored under the gear
  // button, clamped to stay fully on screen on narrow or zoomed viewports.
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = panel?.parentElement;
    if (!panel || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(
      margin,
      Math.min(a.right - panel.offsetWidth, window.innerWidth - margin - panel.offsetWidth)
    );
    setPos({ top: a.bottom + 4, left });
  }, []);

  const flexDefs = useMemo(() => {
    const used = new Set<string>();
    for (const c of components) {
      const def = resolveComponentDef(c, componentDefs);
      if (def?.flexible) used.add(def.id);
    }
    return componentDefs.filter((d) => used.has(d.id));
  }, [components, componentDefs]);

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        ref={panelRef}
        style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
        className="fixed z-50 w-[31rem] max-w-[calc(100vw-1rem)] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg dark:shadow-neutral-900/50 p-4"
      >
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Auto-layout settings</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
          Per bendable component type: pin spacing as the number of holes the part spans
          from pin to pin, and clearance as the number of free rows/columns the body keeps
          to any neighbour. Clearance 0 allows parts to sit directly side by side.
        </p>
        {flexDefs.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-3">
            No flexible components in this project yet.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2 max-h-[45vh] overflow-y-auto">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              <span className="flex-1" />
              <span className="w-[6.75rem] text-center">Pin spacing</span>
              <span className="w-20 text-center">Clearance</span>
              <span className="w-12" />
            </div>
            {flexDefs.map((def) => {
              const base = spanLimits(def);
              const ov = spanOverrides?.[def.id];
              const cur = ov ?? base;
              const clrOv = clearanceOverrides?.[def.id];
              const clr = clrOv ?? DEFAULT_CLEARANCE;
              const inputClass =
                "w-12 border border-neutral-300 dark:border-neutral-600 rounded px-1.5 py-0.5 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-900 outline-none focus:border-blue-400 text-center";
              return (
                <div key={def.id} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                  <span className="flex-1 truncate" title={`${def.name} (default spacing ${base.min + 1} to ${base.max + 1}, clearance ${DEFAULT_CLEARANCE})`}>
                    {def.name}
                  </span>
                  <input
                    type="number"
                    min={2}
                    max={31}
                    value={cur.min + 1}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      setSpanOverride(def.id, { min: Number.isNaN(v) ? base.min : v - 1, max: cur.max });
                    }}
                    className={inputClass}
                    title="Smallest allowed span, in holes from pin to pin"
                  />
                  <span className="text-neutral-400 dark:text-neutral-500">to</span>
                  <input
                    type="number"
                    min={2}
                    max={31}
                    value={cur.max + 1}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      setSpanOverride(def.id, { min: cur.min, max: Number.isNaN(v) ? base.max : v - 1 });
                    }}
                    className={inputClass}
                    title="Largest allowed span, in holes from pin to pin"
                  />
                  <input
                    type="number"
                    min={0}
                    max={5}
                    step={1}
                    value={clr}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      setClearanceOverride(def.id, Number.isNaN(v) ? null : v);
                    }}
                    className={`${inputClass} w-20`}
                    title="Free rows/columns this part's body keeps to any neighbour. Default 1; 0 allows placing it directly adjacent."
                  />
                  <button
                    onClick={() => {
                      setSpanOverride(def.id, null);
                      setClearanceOverride(def.id, null);
                    }}
                    title="Reset to defaults"
                    disabled={!ov && clrOv === undefined}
                    className={`w-12 flex-shrink-0 text-xs transition-colors ${ov || clrOv !== undefined
                      ? "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100"
                      : "text-neutral-300 dark:text-neutral-600 cursor-default"}`}
                  >
                    Reset
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <label className="flex items-center justify-between gap-2 cursor-pointer">
            <span className="text-sm text-neutral-700 dark:text-neutral-200">Drilled cuts only</span>
            <input
              type="checkbox"
              checked={drilledCutsOnly !== false}
              onChange={(e) => setDrilledCutsOnly(e.target.checked)}
              className="h-4 w-4 accent-blue-500"
            />
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
            Sever strips by drilling out a hole instead of cutting the copper between
            two holes wherever possible. The board may come out slightly larger. Directly
            neighbouring pins of a part still force a knife cut between them.
          </p>
        </div>
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <label className="flex items-center justify-between gap-2 cursor-pointer">
            <span className="text-sm text-neutral-700 dark:text-neutral-200">No stacked wires</span>
            <input
              type="checkbox"
              checked={noWireStacking !== false}
              onChange={(e) => setNoWireStacking(e.target.checked)}
              className="h-4 w-4 accent-blue-500"
            />
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
            Never runs one wire on top of another. Keeps the board buildable with thick
            or uninsulated wire; the board may come out larger.
          </p>
        </div>
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-neutral-700 dark:text-neutral-200">Layouts to solve</span>
                <span className="text-sm text-neutral-500 dark:text-neutral-400 w-14 text-right">{workers}</span>
              </div>
              <input
                type="range"
                min={1}
                max={cores}
                step={1}
                value={workers}
                onChange={(e) => setPermWorkers(Math.max(1, Math.min(cores, parseInt(e.target.value))))}
                className="w-full mt-1 accent-blue-500"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
                Alternative layouts of the same circuit, solved at the same time, one per processor
                core (this machine reports {cores}); the best one is applied. All of them take the
                time set below, and using every core can make this device sluggish while solving.
              </p>
          </div>
          <div className="mt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-neutral-700 dark:text-neutral-200">Time per layout</span>
              <span className="text-sm text-neutral-500 dark:text-neutral-400 w-14 text-right">
                {(v5TimeS ?? 60) >= 60 ? `${Math.round((v5TimeS ?? 60) / 60)} min` : `${v5TimeS} s`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={V5_TIME_STOPS.length - 1}
              step={1}
              value={Math.max(0, V5_TIME_STOPS.indexOf(v5TimeS ?? 60))}
              onChange={(e) => setV5TimeS(V5_TIME_STOPS[parseInt(e.target.value)])}
              className="w-full mt-1 accent-blue-500"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
              How long each layout anneals on this machine. Small circuits may finish sooner,
              since more time buys them nothing; big ones use it all and may profit from even more time than
              the default setting grants them.
            </p>
          </div>
          <div className="mt-3">
            <label className="flex items-center justify-between gap-2 cursor-pointer">
              <span className="text-sm text-neutral-700 dark:text-neutral-200">New layouts every run</span>
              <input
                type="checkbox"
                checked={v5RandomSeeds === true}
                onChange={(e) => setV5RandomSeeds(e.target.checked)}
                className="h-4 w-4 accent-blue-500"
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
              Starts every run from fresh random arrangements, so each click offers different
              boards. Off, the same circuit and settings give the same board again.
            </p>
          </div>
          <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
            <a href="/how-auto-layout-works" target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--copper)] hover:underline">
              How the layouter works, with demos to play with &rarr;
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
