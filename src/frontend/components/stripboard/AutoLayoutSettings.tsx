"use client";

import { useMemo } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { resolveComponentDef } from "@/utils/resolveComponentDef";
import { spanLimits, DEFAULT_CLEARANCE } from "./flexGeometry";

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
  const tidyWires = useProjectStore((s) => s.tidyWires);
  const setTidyWires = useProjectStore((s) => s.setTidyWires);
  const permTimeBudget = useProjectStore((s) => s.permTimeBudget);
  const setPermTimeBudget = useProjectStore((s) => s.setPermTimeBudget);
  const permWorkers = useProjectStore((s) => s.permWorkers);
  const setPermWorkers = useProjectStore((s) => s.setPermWorkers);
  const maxWorkers = Math.max(1, (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) - 1);
  const workers = Math.min(permWorkers ?? Math.min(4, maxWorkers), maxWorkers);
  // Slider stops for the time budget; 0 = off (single solve)
  const BUDGET_STOPS = [0, 2, 5, 10, 20, 30, 60, 120];
  const budgetIdx = BUDGET_STOPS.findIndex((s) => s >= (permTimeBudget ?? 0));

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
      <div className="absolute right-0 top-full mt-1 z-50 w-[26rem] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg dark:shadow-neutral-900/50 p-4">
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Auto-layout settings</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
          Per component type: pin spacing as the number of holes the part spans from pin to
          pin, and clearance as air around the body in holes. Clearance 0 allows parts to sit
          directly side by side. Applies on the next run.
        </p>
        {flexDefs.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-3">
            No flexible components in this project yet.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              <span className="flex-1" />
              <span className="w-[6.75rem] text-center">Pin spacing</span>
              <span className="w-20 text-center">Clearance</span>
              <span className="w-8" />
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
                    step={0.25}
                    value={clr}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setClearanceOverride(def.id, Number.isNaN(v) ? null : v);
                    }}
                    className={`${inputClass} w-20`}
                    title="Air around the body, in holes. Default 0.5 keeps one strip free beside this part; 0 allows placing it directly adjacent."
                  />
                  <button
                    onClick={() => {
                      setSpanOverride(def.id, null);
                      setClearanceOverride(def.id, null);
                    }}
                    title="Reset to defaults"
                    disabled={!ov && clrOv === undefined}
                    className={`w-8 text-xs transition-colors ${ov || clrOv !== undefined
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
            <span className="text-sm text-neutral-700 dark:text-neutral-200">Straighter wires</span>
            <input
              type="checkbox"
              checked={tidyWires !== false}
              onChange={(e) => setTidyWires(e.target.checked)}
              className="h-4 w-4 accent-blue-500"
            />
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
            Runs a second solver pass that trades some board space for fewer slanted
            and crossing wires, kept only when it actually is tidier. Turning it off
            roughly halves the solve time. Applies on the next run.
          </p>
        </div>
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-neutral-700 dark:text-neutral-200">Extra solving time</span>
            <span className="text-sm text-neutral-500 dark:text-neutral-400 w-14 text-right">
              {permTimeBudget ? `${permTimeBudget}s` : "off"}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={BUDGET_STOPS.length - 1}
            step={1}
            value={budgetIdx < 0 ? BUDGET_STOPS.length - 1 : budgetIdx}
            onChange={(e) => setPermTimeBudget(BUDGET_STOPS[parseInt(e.target.value)])}
            className="w-full mt-1 accent-blue-500"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
            Keeps solving alternative layouts of the same circuit until the time is
            up and applies the best one found. Each alternative is deterministic, so
            rerunning with the same budget on the same machine gives the same board.
          </p>
          {(permTimeBudget ?? 0) > 0 && (
            <label className="mt-2 flex items-center justify-between gap-2">
              <span className="text-sm text-neutral-700 dark:text-neutral-200">Parallel solvers</span>
              <input
                type="number"
                min={1}
                max={maxWorkers}
                value={workers}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (!Number.isNaN(v)) setPermWorkers(Math.max(1, Math.min(maxWorkers, v)));
                }}
                className="w-14 border border-neutral-300 dark:border-neutral-600 rounded px-1.5 py-0.5 text-sm text-neutral-900 dark:text-neutral-100 dark:bg-neutral-900 outline-none focus:border-blue-400 text-center"
                title={`How many layouts to solve at once (this machine reports ${maxWorkers + 1} cores)`}
              />
            </label>
          )}
        </div>
      </div>
    </>
  );
}
