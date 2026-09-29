"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { LAYOUT_VERSION, V5_EFFORT_DEFAULT, V5_EFFORT_STOPS, defaultPermWorkers, effortPlan, probeRunS } from "./layoutTypes";
import type { AutoLayoutWorkerMessage } from "./autoLayoutWorker";
import { useBoardView } from "@/hooks/useBoardView";
import { track } from "@/lib/track";

/**
 * Popup with the project's auto-layout settings. Rendered below the gear
 * button next to the Auto-layout button.
 */
export default function AutoLayoutSettings({ onClose }: { onClose: () => void }) {
  const drilledCutsOnly = useProjectStore((s) => s.drilledCutsOnly);
  const setDrilledCutsOnly = useProjectStore((s) => s.setDrilledCutsOnly);
  const permWorkers = useProjectStore((s) => s.permWorkers);
  const setPermWorkers = useProjectStore((s) => s.setPermWorkers);
  const v5Effort = useProjectStore((s) => s.v5Effort) ?? V5_EFFORT_DEFAULT;
  const setV5Effort = useProjectStore((s) => s.setV5Effort);
  const v5RunS = useProjectStore((s) => s.v5RunS);
  const board = useProjectStore((s) => s.board);
  const componentDefs = useProjectStore((s) => s.componentDefs);
  const nets = useProjectStore((s) => s.nets);
  const { components, netAssignments } = useBoardView();
  const noWireStacking = useProjectStore((s) => s.noWireStacking);
  const setNoWireStacking = useProjectStore((s) => s.setNoWireStacking);
  const allowStanding = useProjectStore((s) => s.allowStanding);
  const setAllowStanding = useProjectStore((s) => s.setAllowStanding);
  const partSpacing = useProjectStore((s) => s.partSpacing);
  const setPartSpacing = useProjectStore((s) => s.setPartSpacing);
  const v5RandomSeeds = useProjectStore((s) => s.v5RandomSeeds);
  const setV5RandomSeeds = useProjectStore((s) => s.setV5RandomSeeds);
  const cores = Math.max(1, typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4);
  const workers = Math.min(permWorkers ?? defaultPermWorkers(cores), cores);
  // the effort stops, Quick to Exhaustive (what each runs: effortPlan)
  const EFFORT_NAMES = ["Quick", "Normal", "Thorough", "Very thorough", "Exhaustive"];
  const effortIdx = V5_EFFORT_STOPS.indexOf(v5Effort);
  // what a layout takes at this effort: the last full run of this layouter
  // version on this machine, or before one, a rough guess from a speed probe
  // (a worker times random decodes of this circuit)
  const measured = v5RunS?.version === LAYOUT_VERSION ? v5RunS.s : undefined;
  const [probeMs, setProbeMs] = useState<number>();
  useEffect(() => {
    if (measured !== undefined) return;
    const worker = new Worker(new URL("./autoLayoutWorker.ts", import.meta.url));
    worker.onmessage = (e: MessageEvent<AutoLayoutWorkerMessage>) => {
      if (e.data.type === "probe") setProbeMs(e.data.msPerDecode);
      worker.terminate();
    };
    worker.postMessage({ board, components, componentDefs, nets, netAssignments, engine: "v5", partSpacing, allowStanding, v5Probe: 200 });
    return () => worker.terminate();
    // once per opening: the circuit does not change while the popup is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // wired pins of the parts the layouter places, as the editor counts them
  const placeable = new Set(components.filter((c) => !c.boardExcluded).map((c) => c.id));
  const nPins = netAssignments.filter((a) => placeable.has(a.componentId)).length;
  // the stop's layouts run in waves of as many as there are threads, and a
  // wave takes about as long as one layout
  const plan = effortPlan(v5Effort, nPins, false);
  const waves = Math.ceil(plan.seeds / Math.min(workers, plan.seeds));
  const layoutS = measured !== undefined ? measured * plan.effort
    : probeMs !== undefined ? probeRunS(probeMs, nPins, plan.effort, false) : undefined;
  const estimateS = layoutS === undefined ? undefined : layoutS * waves;
  const estimate = estimateS === undefined ? undefined
    : estimateS < 60 ? `${Math.max(1, Math.round(estimateS))} s` : `${Math.round(estimateS / 30) / 2} min`;

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
    const top = Math.max(margin, Math.min(a.bottom + 4, window.innerHeight - margin - panel.offsetHeight));
    setPos({ top, left });
  }, []);


  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        ref={panelRef}
        style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
        className="fixed z-50 w-[31rem] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-1rem)] overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg dark:shadow-neutral-900/50 p-4"
      >
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Auto-layout settings</p>
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
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
            Every run starts from fresh random arrangements and offers different boards.
            Off, the same circuit and settings give the same board again.
          </p>
        </div>
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
            Sever strips by drilling out a hole instead of cutting between two holes. The
            board may come out slightly larger; pins right next to each other still need a knife cut.
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
            Never runs one wire on top of another, so thick or bare wire still fits. The
            board may come out larger.
          </p>
        </div>
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <label className="flex items-center justify-between gap-2 cursor-pointer">
            <span className="text-sm text-neutral-700 dark:text-neutral-200">Allow standing parts</span>
            <input
              type="checkbox"
              checked={allowStanding === true}
              onChange={(e) => setAllowStanding(e.target.checked)}
              className="h-4 w-4 accent-blue-500"
            />
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
            Lets resistors and diodes stand on one lead where that saves room.
          </p>
        </div>
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <label className="flex items-center justify-between gap-2 cursor-pointer">
            <span className="text-sm text-neutral-700 dark:text-neutral-200">Extra room between parts</span>
            <input
              type="checkbox"
              checked={(partSpacing ?? 0) > 0}
              onChange={(e) => setPartSpacing(e.target.checked ? 1 : 0)}
              className="h-4 w-4 accent-blue-500"
            />
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
            Keeps a free row or column between all parts for easier soldering. Off packs
            them as tightly as they physically fit.
          </p>
        </div>
        <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-neutral-700 dark:text-neutral-200">Effort</span>
              <span className="text-sm text-neutral-500 dark:text-neutral-400 text-right">
                {EFFORT_NAMES[effortIdx] ?? `${v5Effort}x`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={V5_EFFORT_STOPS.length - 1}
              step={1}
              value={effortIdx >= 0 ? effortIdx : V5_EFFORT_STOPS.indexOf(V5_EFFORT_DEFAULT)}
              onChange={(e) => setV5Effort(V5_EFFORT_STOPS[parseInt(e.target.value)])}
              className="w-full mt-1 accent-blue-500"
            />
            <p className={`text-sm mt-1 ${estimate ? "font-medium text-neutral-800 dark:text-neutral-100" : "text-neutral-400 dark:text-neutral-500"}`}>
              {estimate ? `expected to run ~${estimate} on this machine` : "timing this machine..."}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-snug">
              More effort solves more layouts and searches each one longer; the best one is
              applied. On big circuits each step roughly doubles the time. A layout stops
              after 20 minutes max.
            </p>
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-neutral-700 dark:text-neutral-200">Processor threads</span>
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
              Layouts solved at the same time (this machine has {cores} threads). More finish
              sooner but can slow the device down; the board you get stays the same.
            </p>
          </div>
          <div className="mt-3 border-t border-neutral-200 dark:border-neutral-700 pt-3">
            <a href="/how-auto-layout-works" target="_blank" rel="noopener noreferrer" onClick={() => track("content-cta", { from: "layout-settings", to: "explainer" })} className="text-xs text-[var(--copper)] hover:underline">
              How the layouter works, with demos to play with &rarr;
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
